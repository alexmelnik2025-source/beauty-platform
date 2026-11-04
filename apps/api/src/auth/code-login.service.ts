import { randomInt } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import { generateToken, hashToken } from '../common/crypto';
import type { Locale, User } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { InvitationsService } from '../organizations/invitations.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';
import type { LoginCodeSentResponse } from './auth.responses';
import type { RequestLoginCodeInput, VerifyLoginCodeInput } from './auth.schemas';
import { AuthService, type IssuedTokens } from './auth.service';
import { PasswordService } from './password.service';

const MINUTE_MS = 60_000;
export const LOGIN_CODE_MINUTES = 10;
export const MAX_LOGIN_CODE_ATTEMPTS = 5;

const SMS_TEXT: Record<Locale, (code: string) => string> = {
  pl: (code) => `Kod logowania do aplikacji salonu: ${code}. Ważny ${LOGIN_CODE_MINUTES} min.`,
  uk: (code) => `Код входу до застосунку салону: ${code}. Дійсний ${LOGIN_CODE_MINUTES} хв.`,
  ru: (code) => `Код входа в приложение салона: ${code}. Действует ${LOGIN_CODE_MINUTES} мин.`,
  en: (code) => `Salon app sign-in code: ${code}. Valid for ${LOGIN_CODE_MINUTES} min.`,
  tr: (code) => `Salon uygulaması giriş kodu: ${code}. ${LOGIN_CODE_MINUTES} dk geçerli.`,
  sq: (code) =>
    `Kodi i hyrjes në aplikacionin e sallonit: ${code}. I vlefshëm ${LOGIN_CODE_MINUTES} min.`,
};

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
  tr: {
    subject: 'Salon uygulaması giriş kodu',
    text: (code) =>
      `Kod: ${code}\n\nGiriş yapmak için bu kodu uygulamaya girin. Kod ${LOGIN_CODE_MINUTES} dakika geçerlidir.\n\nBu siz değilseniz, bu e-postayı dikkate almayın.`,
  },
  sq: {
    subject: 'Kodi i hyrjes në aplikacionin e sallonit',
    text: (code) =>
      `Kodi: ${code}\n\nShkruajeni në aplikacion për t'u identifikuar. Kodi është i vlefshëm ${LOGIN_CODE_MINUTES} minuta.\n\nNëse nuk ishit ju, injorojeni këtë email.`,
  },
};

const notSent = (): AppException =>
  new AppException(HttpStatus.BAD_REQUEST, 'CODE_NOT_SENT', 'Request a code first');

/**
 * Passwordless sign-in for salon accounts (business app and web cabinet): a 6-digit code by
 * email, or by phone number (SMS when a gateway is connected; until then the code goes to the
 * email of the account or invitation that has this number). Works for existing accounts and for people the owner (or a manager) invited: the
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
    private readonly sms: SmsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Same outcome for every address or number, so it cannot be used to find out who has an
   * account: the channel depends only on whether an SMS gateway is connected.
   */
  async requestCode(input: RequestLoginCodeInput): Promise<LoginCodeSentResponse> {
    const expiresAt = new Date(Date.now() + LOGIN_CODE_MINUTES * MINUTE_MS);
    const bySms = input.phone !== undefined && this.sms.available;
    const answer: LoginCodeSentResponse = {
      codeExpiresAt: expiresAt.toISOString(),
      channel: bySms ? 'sms' : 'email',
    };
    const target = await this.resolve(input);
    if (!target) return answer;
    const { email, user } = target;
    const phone = input.phone ?? null;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = this.codeHash(email, code);
    await this.prisma.$transaction(async (tx) => {
      // A number points at one pending code; a new code replaces the previous one.
      if (phone) await tx.staffLoginCode.deleteMany({ where: { phone, email: { not: email } } });
      await tx.staffLoginCode.upsert({
        where: { email },
        create: { email, phone, bySms, codeHash, expiresAt },
        update: { phone, bySms, codeHash, expiresAt, attempts: 0, createdAt: new Date() },
      });
    });
    const locale = user?.locale ?? input.locale;
    if (bySms && phone) {
      await this.sms.send({ to: phone, text: SMS_TEXT[locale](code) });
    } else {
      const words = WORDS[locale];
      await this.mail.send({ to: email, subject: words.subject, text: words.text(code) });
    }
    return answer;
  }

  /**
   * Who the code is for: the account with this email or phone, or the invited address.
   * By phone: an account with that number first, then the newest pending invitation with it.
   */
  private async resolve(
    input: RequestLoginCodeInput,
  ): Promise<{ email: string; user: User | null } | null> {
    if (input.email) {
      const user = await this.prisma.user.findUnique({ where: { email: input.email } });
      if (user || (await this.invitations.hasPending(input.email))) {
        return { email: input.email, user };
      }
      return null;
    }
    if (!input.phone) return null;
    const user = await this.prisma.user.findUnique({ where: { phone: input.phone } });
    if (user) return { email: user.email, user };
    const invited = await this.invitations.pendingEmailForPhone(input.phone);
    if (!invited) return null;
    // The invited address may already have an account (invited to a second salon).
    const existing = await this.prisma.user.findUnique({ where: { email: invited } });
    return { email: invited, user: existing };
  }

  async verifyCode(input: VerifyLoginCodeInput, userAgent?: string): Promise<IssuedTokens> {
    const stored = input.phone
      ? await this.prisma.staffLoginCode.findUnique({ where: { phone: input.phone } })
      : await this.prisma.staffLoginCode.findUnique({ where: { email: input.email! } });
    // A code requested by phone is entered with the phone (and the other way round).
    if (!stored || (input.email && stored.phone)) throw notSent();
    const email = stored.email;
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
    if (stored.codeHash !== this.codeHash(email, input.code)) {
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
    const staffName = await this.invitations.invitedStaffName(email);
    // An SMS code proves the phone; an emailed code proves the address.
    const provenPhone = stored.bySms ? (stored.phone ?? undefined) : undefined;
    const { user, created, joined } = await this.prisma.$transaction(async (tx) => {
      // The code is single use, even when two requests race with it.
      const used = await tx.staffLoginCode.deleteMany({
        where: { id: stored.id, codeHash: stored.codeHash },
      });
      if (used.count !== 1) throw notSent();
      const now = new Date();
      let account: User | null = await tx.user.findUnique({ where: { email } });
      let isNew = false;
      if (!account) {
        account = await tx.user.create({
          data: {
            email,
            passwordHash: unusablePassword,
            name: input.name ?? staffName ?? email.split('@')[0]!,
            locale: input.locale,
            emailVerifiedAt: stored.bySms ? null : now,
          },
        });
        isNew = true;
      } else if (!account.emailVerifiedAt && !stored.bySms) {
        // The code proves the address, like the verification link.
        account = await tx.user.update({
          where: { id: account.id },
          data: { emailVerifiedAt: now },
        });
      }
      const teams = await this.invitations.acceptPendingForEmail(
        tx,
        account.id,
        email,
        provenPhone,
      );
      if (isNew && teams.length === 0) {
        // The invitation was cancelled after the code was sent: no account without one.
        throw new AppException(
          HttpStatus.FORBIDDEN,
          'NO_INVITATION',
          'There is no account or valid invitation for this email or phone',
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
