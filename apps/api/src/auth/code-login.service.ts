import { randomInt } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import { generateToken, hashToken } from '../common/crypto';
import type { Locale, User } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { InvitationsService } from '../organizations/invitations.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestLoginCodeInput, VerifyLoginCodeInput } from './auth.schemas';
import { AuthService, type IssuedTokens } from './auth.service';
import { PasswordService } from './password.service';

const MINUTE_MS = 60_000;
export const LOGIN_CODE_MINUTES = 10;
export const MAX_LOGIN_CODE_ATTEMPTS = 5;

const WORDS: Record<Locale, { subject: string; text: (code: string) => string }> = {
  pl: {
    subject: 'Kod logowania do aplikacji salonu',
    text: (code) =>
      `Kod: ${code}\n\nWpisz go w aplikacji, aby się zalogować. Kod jest ważny ${LOGIN_CODE_MINUTES} minut.\n\nJeśli to nie Ty, zignoruj tę wiadomość.`,
  },
  uk: {
    subject: 'Код входу до застосунку салону',
    text: (code) =>
      `Код: ${code}\n\nВведіть його в застосунку, щоб увійти. Код дійсний ${LOGIN_CODE_MINUTES} хвилин.\n\nЯкщо це були не ви, проігноруйте цей лист.`,
  },
  ru: {
    subject: 'Код входа в приложение салона',
    text: (code) =>
      `Код: ${code}\n\nВведите его в приложении, чтобы войти. Код действует ${LOGIN_CODE_MINUTES} минут.\n\nЕсли это были не вы, проигнорируйте это письмо.`,
  },
  en: {
    subject: 'Sign-in code for the salon app',
    text: (code) =>
      `Code: ${code}\n\nEnter it in the app to sign in. The code is valid for ${LOGIN_CODE_MINUTES} minutes.\n\nIf this was not you, ignore this email.`,
  },
};

const notSent = (): AppException =>
  new AppException(HttpStatus.BAD_REQUEST, 'CODE_NOT_SENT', 'Request a code first');

/**
 * Passwordless sign-in for salon accounts (business app and web cabinet): a 6-digit code by
 * email. Works for existing accounts and for people the owner (or a manager) invited: the
 * account is created on first sign-in and every pending invitation is accepted, so the person
 * lands straight in their salon with the invited role. Nobody can create a team role this way
 * on their own: without an account or an invitation no code is sent.
 */
@Injectable()
export class CodeLoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly invitations: InvitationsService,
    private readonly passwords: PasswordService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  /** Same outcome for every address, so it cannot be used to find out who has an account. */
  async requestCode(input: RequestLoginCodeInput): Promise<{ codeExpiresAt: string }> {
    const expiresAt = new Date(Date.now() + LOGIN_CODE_MINUTES * MINUTE_MS);
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user && !(await this.invitations.hasPending(input.email))) {
      return { codeExpiresAt: expiresAt.toISOString() };
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = this.codeHash(input.email, code);
    // A new code replaces the previous one.
    await this.prisma.staffLoginCode.upsert({
      where: { email: input.email },
      create: { email: input.email, codeHash, expiresAt },
      update: { codeHash, expiresAt, attempts: 0, createdAt: new Date() },
    });
    const words = WORDS[user?.locale ?? input.locale];
    await this.mail.send({ to: input.email, subject: words.subject, text: words.text(code) });
    return { codeExpiresAt: expiresAt.toISOString() };
  }

  async verifyCode(input: VerifyLoginCodeInput, userAgent?: string): Promise<IssuedTokens> {
    const stored = await this.prisma.staffLoginCode.findUnique({ where: { email: input.email } });
    if (!stored) throw notSent();
    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new AppException(HttpStatus.GONE, 'CODE_EXPIRED', 'The code has expired');
    }
    if (stored.attempts >= MAX_LOGIN_CODE_ATTEMPTS) {
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        'TOO_MANY_ATTEMPTS',
        'Too many wrong codes. Request a new one',
      );
    }
    if (stored.codeHash !== this.codeHash(input.email, input.code)) {
      await this.prisma.staffLoginCode.update({
        where: { id: stored.id },
        data: { attempts: { increment: 1 } },
      });
      throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_CODE', 'Wrong code', [
        {
          path: 'code',
          message: `${MAX_LOGIN_CODE_ATTEMPTS - stored.attempts - 1} attempts left`,
        },
      ]);
    }

    // Accounts created by a code get a random password nobody knows; "forgot password" sets one.
    const unusablePassword = await this.passwords.hash(generateToken());
    const staffName = await this.invitations.invitedStaffName(input.email);
    const { user, created, joined } = await this.prisma.$transaction(async (tx) => {
      // The code is single use, even when two requests race with it.
      const used = await tx.staffLoginCode.deleteMany({
        where: { id: stored.id, codeHash: stored.codeHash },
      });
      if (used.count !== 1) throw notSent();
      const now = new Date();
      let account: User | null = await tx.user.findUnique({ where: { email: input.email } });
      let isNew = false;
      if (!account) {
        account = await tx.user.create({
          data: {
            email: input.email,
            passwordHash: unusablePassword,
            name: input.name ?? staffName ?? input.email.split('@')[0]!,
            locale: input.locale,
            emailVerifiedAt: now,
          },
        });
        isNew = true;
      } else if (!account.emailVerifiedAt) {
        // The code proves the address, like the verification link.
        account = await tx.user.update({
          where: { id: account.id },
          data: { emailVerifiedAt: now },
        });
      }
      const teams = await this.invitations.acceptPendingForEmail(tx, account.id, input.email);
      if (isNew && teams.length === 0) {
        // The invitation was cancelled after the code was sent: no account without one.
        throw new AppException(
          HttpStatus.FORBIDDEN,
          'NO_INVITATION',
          'There is no account or valid invitation for this email',
        );
      }
      return { user: account, created: isNew, joined: teams };
    });
    if (created) {
      await this.audit.record({
        actorUserId: user.id,
        action: 'user.registered_by_code',
        entityType: 'user',
        entityId: user.id,
        metadata: { organizations: joined.map((j) => j.organizationId) },
      });
    }
    return this.auth.issueSession(user, {
      clientType: input.clientType,
      deviceName: input.deviceName,
      userAgent,
    });
  }

  private codeHash(email: string, code: string): string {
    return hashToken(`staff:${email}:${code}`);
  }
}
