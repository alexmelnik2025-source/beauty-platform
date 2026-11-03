import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { LOCALES, phoneSchema } from '../auth/auth.schemas';
import { AppException, forbidden, notFound } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import { generateToken, hashToken } from '../common/crypto';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { MembershipContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { Invitation, Locale, Prisma } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  InvitationAcceptedResponse,
  InvitationPreviewResponse,
  InvitationResponse,
} from './team.responses';

const DAY_MS = 86_400_000;
const INVITATION_DAYS = 7;

export const createInvitationSchema = z
  .object({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
    /** Optional: the person can then also sign in to the business app by this number. */
    phone: phoneSchema.optional(),
    role: z.enum(['manager', 'staff']),
    locationIds: z.array(z.uuid()).min(1).max(50),
    /** Staff only: the calendar profile the new account takes over. */
    staffMemberId: z.uuid().optional(),
    /** Staff only: the permissions category. */
    staffCategoryId: z.uuid().optional(),
    /** Language of the invitation email. */
    locale: z.enum(LOCALES).default('pl'),
  })
  .refine((v) => v.role === 'staff' || (!v.staffMemberId && !v.staffCategoryId), {
    message: 'staffMemberId and staffCategoryId are for staff invitations',
    path: ['role'],
  });
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export type {
  InvitationAcceptedResponse,
  InvitationPreviewResponse,
  InvitationResponse,
} from './team.responses';

const TEXTS: Record<Locale, { subject: string; text: (org: string, link: string) => string }> = {
  pl: {
    subject: 'Zaproszenie do zespołu',
    text: (org, link) =>
      `${org} zaprasza Cię do swojego zespołu.\n\nAby przyjąć zaproszenie, otwórz link (ważny 7 dni) i zaloguj się lub załóż konto na ten adres e-mail:\n${link}\n\nJeśli nie spodziewasz się zaproszenia, zignoruj tę wiadomość.`,
  },
  uk: {
    subject: 'Запрошення до команди',
    text: (org, link) =>
      `${org} запрошує вас до своєї команди.\n\nЩоб прийняти запрошення, відкрийте посилання (дійсне 7 днів) і увійдіть або створіть акаунт на цю адресу:\n${link}\n\nЯкщо ви не очікували запрошення, проігноруйте цей лист.`,
  },
  ru: {
    subject: 'Приглашение в команду',
    text: (org, link) =>
      `${org} приглашает вас в свою команду.\n\nЧтобы принять приглашение, откройте ссылку (действует 7 дней) и войдите или создайте аккаунт на этот адрес:\n${link}\n\nЕсли вы не ждали приглашения, проигнорируйте это письмо.`,
  },
  en: {
    subject: 'Invitation to the team',
    text: (org, link) =>
      `${org} invites you to join their team.\n\nTo accept, open the link (valid for 7 days) and sign in or create an account with this email address:\n${link}\n\nIf you were not expecting this, ignore this email.`,
  },
};

const invitationGone = (): AppException =>
  new AppException(HttpStatus.GONE, 'INVITATION_EXPIRED', 'This invitation is no longer valid');

function statusOf(i: Invitation): InvitationResponse['status'] {
  if (i.acceptedAt) return 'accepted';
  if (i.revokedAt) return 'revoked';
  if (i.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'pending';
}

function toResponse(i: Invitation): InvitationResponse {
  return {
    id: i.id,
    email: i.email,
    phone: i.phone,
    role: i.role,
    locationIds: i.locationIds,
    staffMemberId: i.staffMemberId,
    staffCategoryId: i.staffCategoryId,
    status: statusOf(i),
    expiresAt: i.expiresAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
  };
}

/**
 * Inviting managers and staff by email, accepting, and removing people.
 * Owners invite anyone; managers invite staff to their own locations.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly limiter: RateLimiterService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(
    m: MembershipContext,
    actorUserId: string,
    input: CreateInvitationInput,
  ): Promise<InvitationResponse> {
    if (m.role === 'manager') {
      const own = input.locationIds.every((id) => m.locationIds.includes(id));
      if (input.role !== 'staff' || !own) throw forbidden();
    }
    this.limiter.hit(`invite:org:${m.organizationId}`, 30, 60 * 60_000);
    const locations = await this.prisma.location.count({
      where: { id: { in: input.locationIds }, organizationId: m.organizationId },
    });
    if (locations !== new Set(input.locationIds).size) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Unknown location', [
        { path: 'locationIds', message: 'every location must belong to this organization' },
      ]);
    }
    if (input.staffMemberId) {
      const staff = await this.prisma.staffMember.findFirst({
        where: { id: input.staffMemberId, locationId: { in: input.locationIds } },
      });
      if (!staff) {
        throw new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Unknown staff member', [
          { path: 'staffMemberId', message: 'must be a staff member of the invited locations' },
        ]);
      }
      if (staff.userId) {
        throw new AppException(
          HttpStatus.CONFLICT,
          'STAFF_ALREADY_LINKED',
          'This staff profile already belongs to an account',
        );
      }
    }
    if (input.staffCategoryId) {
      const category = await this.prisma.staffCategory.count({
        where: { id: input.staffCategoryId, organizationId: m.organizationId },
      });
      if (category === 0) {
        throw new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Unknown category', [
          { path: 'staffCategoryId', message: 'must be a category of this organization' },
        ]);
      }
    }
    const member = await this.prisma.membership.findFirst({
      where: { organizationId: m.organizationId, user: { email: input.email } },
    });
    if (member) {
      throw new AppException(
        HttpStatus.CONFLICT,
        'ALREADY_MEMBER',
        'This person is already in the team',
      );
    }

    const token = generateToken();
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: m.organizationId },
    });
    const invitation = await this.prisma.$transaction(async (tx) => {
      // "Invite again": the previous link stops working.
      await tx.invitation.updateMany({
        where: {
          organizationId: m.organizationId,
          email: input.email,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      const created = await tx.invitation.create({
        data: {
          organizationId: m.organizationId,
          email: input.email,
          phone: input.phone ?? null,
          role: input.role,
          locationIds: input.locationIds,
          staffMemberId: input.staffMemberId ?? null,
          staffCategoryId: input.staffCategoryId ?? null,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + INVITATION_DAYS * DAY_MS),
          invitedByUserId: actorUserId,
        },
      });
      await this.record(tx, m, actorUserId, 'invitation.created', created.id, {
        role: input.role,
        withPhone: input.phone !== undefined,
        locationIds: input.locationIds,
      });
      return created;
    });
    const text = TEXTS[input.locale];
    await this.mail.send(
      {
        to: input.email,
        subject: `${text.subject} — ${organization.name}`,
        text: text.text(
          organization.name,
          `${this.config.APP_WEB_URL}/${input.locale}/invite/${token}`,
        ),
      },
      { idempotencyKey: `invitation-${invitation.id}` },
    );
    return toResponse(invitation);
  }

  async list(m: MembershipContext): Promise<InvitationResponse[]> {
    const rows = await this.prisma.invitation.findMany({
      where: {
        organizationId: m.organizationId,
        revokedAt: null,
        createdAt: { gt: new Date(Date.now() - 30 * DAY_MS) },
        ...(m.role === 'owner' ? {} : { role: 'staff', locationIds: { hasSome: m.locationIds } }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toResponse);
  }

  async revoke(m: MembershipContext, actorUserId: string, invitationId: string): Promise<void> {
    const invitation = await this.prisma.invitation.findFirst({
      where: { id: invitationId, organizationId: m.organizationId },
    });
    if (!invitation) throw notFound('Invitation');
    if (m.role === 'manager' && !invitation.locationIds.every((id) => m.locationIds.includes(id))) {
      throw forbidden();
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.invitation.updateMany({
        where: { id: invitationId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.record(tx, m, actorUserId, 'invitation.revoked', invitationId);
    });
  }

  /** For the "join the team" page before signing in. */
  async preview(token: string): Promise<InvitationPreviewResponse> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { organization: true },
    });
    if (!invitation) throw notFound('Invitation');
    return {
      organizationName: invitation.organization.name,
      role: invitation.role,
      email: invitation.email,
      status: statusOf(invitation),
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /** The signed-in user joins; their verified email must be the invited one. */
  async accept(userId: string, token: string): Promise<InvitationAcceptedResponse> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!invitation) throw notFound('Invitation');
    if (statusOf(invitation) !== 'pending') throw invitationGone();
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.email !== invitation.email || !user.emailVerifiedAt) {
      throw new AppException(
        HttpStatus.FORBIDDEN,
        'EMAIL_MISMATCH',
        'Sign in with the email address the invitation was sent to',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const taken = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (taken.count !== 1) throw invitationGone();
      const existing = await tx.membership.findUnique({
        where: { userId_organizationId: { userId, organizationId: invitation.organizationId } },
      });
      if (existing) {
        throw new AppException(
          HttpStatus.CONFLICT,
          'ALREADY_MEMBER',
          'You are already in this team',
        );
      }
      await this.join(tx, invitation, userId);
    });
    return { organizationId: invitation.organizationId, role: invitation.role };
  }

  /**
   * Sign-in with an email code: every pending invitation for this (just proven) address is
   * accepted at once, so an invited manager or staff member lands straight in their salon.
   * Teams the user already belongs to are skipped. Returns the teams joined.
   */
  async acceptPendingForEmail(
    tx: Prisma.TransactionClient,
    userId: string,
    email: string,
    /** A phone number proven by an SMS code: invitations sent to it are accepted too. */
    provenPhone?: string,
  ): Promise<InvitationAcceptedResponse[]> {
    const pending = await tx.invitation.findMany({
      where: {
        OR: provenPhone ? [{ email }, { phone: provenPhone }] : [{ email }],
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    const joined: InvitationAcceptedResponse[] = [];
    for (const invitation of pending) {
      if (joined.some((j) => j.organizationId === invitation.organizationId)) continue;
      const member = await tx.membership.count({
        where: { userId, organizationId: invitation.organizationId },
      });
      if (member > 0) continue;
      const taken = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (taken.count !== 1) continue;
      await this.join(tx, invitation, userId);
      joined.push({ organizationId: invitation.organizationId, role: invitation.role });
    }
    return joined;
  }

  /** Whether `email` has an invitation that can still be accepted. */
  async hasPending(email: string): Promise<boolean> {
    const count = await this.prisma.invitation.count({
      where: { email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    return count > 0;
  }

  /**
   * Sign-in by phone: the email of the newest invitation that can still be accepted and has
   * this number, or null.
   */
  async pendingEmailForPhone(phone: string): Promise<string | null> {
    const invitation = await this.prisma.invitation.findFirst({
      where: { phone, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return invitation?.email ?? null;
  }

  /** The calendar name of the staff profile an invitation links, for a new account's name. */
  async invitedStaffName(email: string): Promise<string | null> {
    const invitation = await this.prisma.invitation.findFirst({
      where: {
        email,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        staffMemberId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!invitation?.staffMemberId) return null;
    const staff = await this.prisma.staffMember.findUnique({
      where: { id: invitation.staffMemberId },
    });
    return staff?.displayName ?? null;
  }

  /** Creates the membership for an invitation already marked accepted (inside `tx`). */
  private async join(
    tx: Prisma.TransactionClient,
    invitation: Invitation,
    userId: string,
  ): Promise<void> {
    // Locations may have been deleted since the invitation was sent.
    const locations = await tx.location.findMany({
      where: { id: { in: invitation.locationIds }, organizationId: invitation.organizationId },
      select: { id: true },
    });
    const category = invitation.staffCategoryId
      ? await tx.staffCategory.findUnique({ where: { id: invitation.staffCategoryId } })
      : null;
    const membership = await tx.membership.create({
      data: {
        userId,
        organizationId: invitation.organizationId,
        role: invitation.role,
        staffCategoryId: category?.id ?? null,
        locations: { create: locations.map((l) => ({ locationId: l.id })) },
      },
    });
    if (invitation.staffMemberId) {
      await tx.staffMember.updateMany({
        where: { id: invitation.staffMemberId, userId: null },
        data: { userId },
      });
    }
    if (invitation.phone) {
      // The owner vouches for the number: the person can sign in by it from now on, unless the
      // account already has a number or another account uses this one.
      const taken = await tx.user.count({ where: { phone: invitation.phone } });
      if (taken === 0) {
        await tx.user.updateMany({
          where: { id: userId, phone: null },
          data: { phone: invitation.phone },
        });
      }
    }
    await this.audit.record(
      {
        organizationId: invitation.organizationId,
        actorUserId: userId,
        action: 'invitation.accepted',
        entityType: 'membership',
        entityId: membership.id,
        metadata: { invitationId: invitation.id, role: invitation.role },
      },
      tx,
    );
  }

  /** Owner removes a manager or staff member; their staff profile stays in the calendar, unlinked. */
  async removeMember(
    m: MembershipContext,
    actorUserId: string,
    membershipId: string,
  ): Promise<void> {
    const member = await this.prisma.membership.findFirst({
      where: { id: membershipId, organizationId: m.organizationId },
    });
    if (!member) throw notFound('Member');
    if (member.role === 'owner') {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'CANNOT_REMOVE_OWNER',
        'The owner cannot be removed from the organization',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.staffMember.updateMany({
        where: { userId: member.userId, location: { organizationId: m.organizationId } },
        data: { userId: null },
      });
      await tx.membership.delete({ where: { id: membershipId } });
      await this.record(tx, m, actorUserId, 'membership.removed', membershipId, {
        userId: member.userId,
        role: member.role,
      });
    });
  }

  private record(
    tx: Prisma.TransactionClient,
    m: MembershipContext,
    actorUserId: string,
    action: string,
    entityId: string,
    metadata?: Prisma.InputJsonValue,
  ): Promise<void> {
    return this.audit.record(
      {
        organizationId: m.organizationId,
        actorUserId,
        action,
        entityType: action.split('.')[0]!,
        entityId,
        metadata,
      },
      tx,
    );
  }
}
