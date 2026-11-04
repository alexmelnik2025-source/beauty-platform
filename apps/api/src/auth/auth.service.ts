import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import { generateToken, hashToken } from '../common/crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { EmailTokenType, User } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { templates } from '../mail/templates';
import { PrismaService } from '../prisma/prisma.service';
import { ACCESS_TOKEN_TTL_SECONDS, AccessTokenService } from './access-token.service';
import type { LoginInput, RegisterInput, ResetPasswordInput } from './auth.schemas';
import { PasswordService } from './password.service';
import type { PublicUser } from './auth.responses';

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_PASSWORD_TTL_MS = 60 * 60 * 1000;

export type { PublicUser } from './auth.responses';

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: PublicUser;
}

interface ClientInfo {
  userAgent?: string;
}

const invalidCredentials = (): AppException =>
  new AppException(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Invalid email or password');

const invalidRefresh = (): AppException =>
  new AppException(
    HttpStatus.UNAUTHORIZED,
    'INVALID_REFRESH_TOKEN',
    'Session expired, sign in again',
  );

const invalidEmailToken = (): AppException =>
  new AppException(HttpStatus.BAD_REQUEST, 'INVALID_TOKEN', 'The link is invalid or has expired');

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    locale: user.locale,
    emailVerified: user.emailVerifiedAt !== null,
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly accessTokens: AccessTokenService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Creates the account and sends a verification email. The response is the same
   * whether or not the email is already registered, so addresses cannot be enumerated.
   */
  async register(input: RegisterInput): Promise<void> {
    // Hash first, so a known and an unknown email take the same time.
    const passwordHash = await this.passwords.hash(input.password);
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      return;
    }
    const user = await this.prisma.user
      .create({
        data: { email: input.email, passwordHash, name: input.name, locale: input.locale },
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) return null; // registered concurrently
        throw error;
      });
    if (!user) return;
    await this.audit.record({
      actorUserId: user.id,
      action: 'user.registered',
      entityType: 'user',
      entityId: user.id,
    });
    await this.sendEmailToken(user, 'verify_email');
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt) {
      await this.sendEmailToken(user, 'verify_email');
    }
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.consumeEmailToken(token, 'verify_email');
    await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
    await this.audit.record({
      actorUserId: userId,
      action: 'user.email_verified',
      entityType: 'user',
      entityId: userId,
    });
  }

  async login(input: LoginInput, client: ClientInfo): Promise<IssuedTokens> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const valid = await this.passwords.verify(user?.passwordHash ?? null, input.password);
    if (!user || !valid) {
      throw invalidCredentials();
    }
    if (!user.emailVerifiedAt) {
      throw new AppException(
        HttpStatus.FORBIDDEN,
        'EMAIL_NOT_VERIFIED',
        'Confirm your email address first',
      );
    }

    return this.issueSession(user, {
      clientType: input.clientType,
      deviceName: input.deviceName,
      userAgent: client.userAgent,
    });
  }

  /** Opens a session on one device (password sign-in and the email-code sign-in). */
  async issueSession(
    user: User,
    device: { clientType: 'web' | 'mobile'; deviceName?: string; userAgent?: string },
  ): Promise<IssuedTokens> {
    const refreshToken = generateToken();
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        clientType: device.clientType,
        deviceName: device.deviceName,
        userAgent: device.userAgent?.slice(0, 300),
        refreshTokenHash: hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
      },
    });
    await this.audit.record({
      actorUserId: user.id,
      action: 'user.logged_in',
      entityType: 'session',
      entityId: session.id,
    });

    return {
      accessToken: this.accessTokens.sign({ userId: user.id, sessionId: session.id }),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshExpiresAt,
      user: toPublicUser(user),
    };
  }

  /**
   * Rotates the refresh token. Presenting an already-rotated token means it was
   * copied by someone else, so the whole session is revoked.
   */
  async refresh(refreshToken: string): Promise<IssuedTokens> {
    const tokenHash = hashToken(refreshToken);
    const now = new Date();

    const reused = await this.prisma.session.findUnique({
      where: { previousRefreshTokenHash: tokenHash },
    });
    if (reused) {
      await this.prisma.session.updateMany({
        where: { id: reused.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.audit.record({
        actorUserId: reused.userId,
        action: 'session.refresh_token_reused',
        entityType: 'session',
        entityId: reused.id,
      });
      throw invalidRefresh();
    }

    const newToken = generateToken();
    const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
    // Conditional update: of two concurrent refreshes with the same token, only one succeeds.
    const updated = await this.prisma.session.updateMany({
      where: { refreshTokenHash: tokenHash, revokedAt: null, expiresAt: { gt: now } },
      data: {
        previousRefreshTokenHash: tokenHash,
        refreshTokenHash: hashToken(newToken),
        lastUsedAt: now,
        expiresAt: refreshExpiresAt,
      },
    });
    if (updated.count !== 1) {
      throw invalidRefresh();
    }
    const session = await this.prisma.session.findUniqueOrThrow({
      where: { refreshTokenHash: hashToken(newToken) },
      include: { user: true },
    });

    return {
      accessToken: this.accessTokens.sign({ userId: session.userId, sessionId: session.id }),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: newToken,
      refreshExpiresAt,
      user: toPublicUser(session.user),
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user) {
      await this.sendEmailToken(user, 'reset_password');
    }
  }

  /** Sets a new password and signs the user out on every device. */
  async resetPassword(input: ResetPasswordInput): Promise<void> {
    const userId = await this.consumeEmailToken(input.token, 'reset_password');
    const passwordHash = await this.passwords.hash(input.newPassword);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.user.update({
        // Receiving the reset email also proves ownership of the address.
        where: { id: userId },
        data: { passwordHash, emailVerifiedAt: now },
      }),
      this.prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
    await this.audit.record({
      actorUserId: userId,
      action: 'user.password_reset',
      entityType: 'user',
      entityId: userId,
    });
  }

  private async sendEmailToken(user: User, type: EmailTokenType): Promise<void> {
    const token = generateToken();
    const ttl = type === 'verify_email' ? VERIFY_EMAIL_TTL_MS : RESET_PASSWORD_TTL_MS;
    await this.prisma.$transaction([
      // Only the newest link works.
      this.prisma.emailToken.updateMany({
        where: { userId: user.id, type, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.emailToken.create({
        data: {
          userId: user.id,
          type,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + ttl),
        },
      }),
    ]);

    const path = type === 'verify_email' ? 'verify-email' : 'reset-password';
    const link = `${this.config.APP_WEB_URL}/${path}?token=${encodeURIComponent(token)}`;
    const template = (type === 'verify_email' ? templates.verifyEmail : templates.resetPassword)[
      user.locale
    ];
    await this.mail.send({
      to: user.email,
      subject: template.subject,
      text: template.text(user.name, link, token),
      lang: user.locale,
    });
  }

  /** Marks a token used (single use, atomic) and returns its user id. */
  private async consumeEmailToken(token: string, type: EmailTokenType): Promise<string> {
    const tokenHash = hashToken(token);
    const now = new Date();
    const record = await this.prisma.emailToken.findUnique({ where: { tokenHash } });
    if (!record || record.type !== type) {
      throw invalidEmailToken();
    }
    const consumed = await this.prisma.emailToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) {
      throw invalidEmailToken();
    }
    return record.userId;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
  );
}
