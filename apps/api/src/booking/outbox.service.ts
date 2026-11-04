import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { generateToken, hashToken } from '../common/crypto';
import type { FailedEmail, OutboxStats } from '../common/system.responses';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { Locale, Prisma } from '../generated/prisma/client';
import { MailService, maskEmails, type MailMessage } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  formatPrice,
  formatWhen,
  renderAppointmentEmail,
  renderPointsExpiringEmail,
  type NotificationKind,
} from './booking-templates';

export interface AppointmentNotification {
  appointmentId: string;
  /** The appointment version the message is about; stale messages are skipped. */
  version: number;
  reason?: string | null;
}

const MAX_ATTEMPTS = 5;
/**
 * A claimed email is locked for 5 minutes — far longer than one send may take
 * (SEND_TIMEOUT_MS = 1 min) — so another server never takes it while it is being sent.
 * Emails are claimed one at a time for the same reason.
 */
export const LOCK_SECONDS = 300;
/** Sent and skipped rows are kept 30 days, failed ones 90 days (to investigate). */
const KEEP_SENT_DAYS = 30;
const KEEP_FAILED_DAYS = 90;
const CLEANUP_EVERY_MS = 60 * 60_000;
const ALERT_CHECK_EVERY_MS = 5 * 60_000;
const ALERT_REPEAT_MS = 60 * 60_000;
const MANAGE_LINK_DAYS_AFTER_VISIT = 7;
const DAY_MS = 86_400_000;

export type { FailedEmail, OutboxStats } from '../common/system.responses';

interface ClaimedRow {
  id: string;
  type: string;
  payload: AppointmentNotification;
  attempts: number;
  next_attempt_at: Date;
}

/**
 * Email queue (transactional outbox).
 * - `enqueue` is called inside the same transaction as the change, so a message is
 *   stored if and only if the change is committed.
 * - The worker claims rows with FOR UPDATE SKIP LOCKED (safe with several API
 *   instances), sends them, and retries failures with back-off.
 * - Each email carries an idempotency key (row id + recipient), so a retry after a
 *   crash between "sent" and "marked as sent" is recognised by the provider.
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Outbox');
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastCleanupAt = 0;
  private lastAlertCheckAt = 0;
  private lastAlertAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.OUTBOX_POLL_MS > 0) {
      this.timer = setInterval(() => void this.tick(), this.config.OUTBOX_POLL_MS);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async enqueue(
    tx: Prisma.TransactionClient,
    type: NotificationKind,
    payload: AppointmentNotification,
    options: { notBefore?: Date; dedupeKey?: string } = {},
  ): Promise<void> {
    await tx.notificationOutbox.createMany({
      data: [
        {
          type,
          payload: payload as unknown as Prisma.InputJsonValue,
          nextAttemptAt: options.notBefore ?? new Date(),
          dedupeKey: options.dedupeKey ?? `${type}:${payload.appointmentId}:${payload.version}`,
        },
      ],
      skipDuplicates: true,
    });
  }

  /** One worker cycle: housekeeping, then send what is due. */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.expireHolds();
      await this.drain();
      const now = Date.now();
      if (now - this.lastCleanupAt >= CLEANUP_EVERY_MS) {
        this.lastCleanupAt = now;
        await this.cleanup();
      }
      if (now - this.lastAlertCheckAt >= ALERT_CHECK_EVERY_MS) {
        this.lastAlertCheckAt = now;
        await this.checkAlerts();
      }
    } catch (error) {
      this.logger.error(
        'Outbox cycle failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Marks holds whose 10 minutes are over as expired and erases contact details of
   * holds that were never confirmed (data minimisation). Slots are free the moment a
   * hold expires anyway — this only tidies up.
   */
  async expireHolds(): Promise<number> {
    const expired = await this.prisma.$executeRaw`
      UPDATE appointment SET status = 'expired', updated_at = now()
      WHERE status = 'held' AND hold_expires_at <= now()`;
    await this.prisma.$executeRaw`
      UPDATE appointment SET hold_contact = NULL
      WHERE status = 'expired' AND hold_contact IS NOT NULL AND updated_at < now() - interval '24 hours'`;
    // Client app: unused sign-in codes (they hold an email address) and expired sessions.
    await this.prisma
      .$executeRaw`DELETE FROM client_login_code WHERE expires_at < now() - interval '1 day'`;
    await this.prisma.$executeRaw`DELETE FROM client_session WHERE expires_at < now()`;
    // Business app: unused sign-in codes of salon accounts.
    await this.prisma
      .$executeRaw`DELETE FROM staff_login_code WHERE expires_at < now() - interval '1 day'`;
    return expired;
  }

  /**
   * Sends due messages. Returns how many rows were processed.
   * `afterSend` is a test hook that simulates a crash right after sending.
   */
  async drain(options: { afterSend?: () => void } = {}): Promise<number> {
    let processed = 0;
    for (;;) {
      // One email per claim: the lock covers exactly the email being sent.
      const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
        UPDATE notification_outbox
        SET locked_until = now() + make_interval(secs => ${LOCK_SECONDS}::int), attempts = attempts + 1
        WHERE id = (
          SELECT id FROM notification_outbox
          WHERE status = 'pending' AND next_attempt_at <= now()
            AND (locked_until IS NULL OR locked_until < now())
          ORDER BY next_attempt_at, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, type, payload, attempts, next_attempt_at`;
      if (rows.length === 0) return processed;

      for (const row of rows) {
        processed += 1;
        try {
          const messages = await this.render(row);
          if (messages === null) {
            await this.finish(row.id, 'skipped');
            continue;
          }
          for (const [index, message] of messages.entries()) {
            await this.mail.send(message, { idempotencyKey: `${row.id}-${index}` });
          }
          options.afterSend?.();
          await this.finish(row.id, 'sent');
        } catch (error) {
          if (error instanceof SimulatedCrash) throw error;
          await this.retryLater(row, error);
        }
      }
    }
  }

  private async finish(id: string, status: 'sent' | 'skipped'): Promise<void> {
    await this.prisma.notificationOutbox.update({
      where: { id },
      data: { status, sentAt: status === 'sent' ? new Date() : null, lockedUntil: null },
    });
  }

  private async retryLater(row: ClaimedRow, error: unknown): Promise<void> {
    // Provider messages may quote the recipient: never store or log addresses.
    const message = maskEmails(error instanceof Error ? error.message : String(error));
    const failed = row.attempts >= MAX_ATTEMPTS;
    // 30 s, 2 min, 4.5 min, 8 min…
    const delayMs = row.attempts * row.attempts * 30_000;
    await this.prisma.notificationOutbox.update({
      where: { id: row.id },
      data: {
        status: failed ? 'failed' : 'pending',
        lastError: message.slice(0, 500),
        lockedUntil: null,
        nextAttemptAt: new Date(Date.now() + delayMs),
      },
    });
    if (failed) {
      this.logger.error(
        `Giving up on ${row.type} ${row.id} after ${row.attempts} attempts: ${message}`,
      );
    }
  }

  // ── Housekeeping, monitoring and manual retry ─────────

  /** Deletes old rows: sent/skipped after 30 days, failed after 90 days. */
  async cleanup(): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM notification_outbox
      WHERE (status IN ('sent', 'skipped') AND created_at < now() - make_interval(days => ${KEEP_SENT_DAYS}::int))
         OR (status = 'failed' AND created_at < now() - make_interval(days => ${KEEP_FAILED_DAYS}::int))`;
  }

  /** Queue health for the administrator page and alerts. */
  async stats(): Promise<OutboxStats> {
    const [row] = await this.prisma.$queryRaw<
      {
        pending: number;
        due: number;
        oldest_due_seconds: number | null;
        failed: number;
        sent_24h: number;
      }[]
    >`
      SELECT
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'pending' AND next_attempt_at <= now())::int AS due,
        floor(extract(epoch FROM now() - min(next_attempt_at) FILTER (
          WHERE status = 'pending' AND next_attempt_at <= now())))::int AS oldest_due_seconds,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '24 hours')::int AS sent_24h
      FROM notification_outbox`;
    const oldestDueSeconds = row?.oldest_due_seconds ?? 0;
    const problems: string[] = [];
    if ((row?.failed ?? 0) > 0) problems.push('failed');
    if (oldestDueSeconds > this.config.OUTBOX_ALERT_AFTER_MINUTES * 60) problems.push('stuck');
    return {
      status: problems.length === 0 ? 'ok' : 'warning',
      problems,
      pending: row?.pending ?? 0,
      due: row?.due ?? 0,
      oldestDueSeconds,
      failed: row?.failed ?? 0,
      sentLast24h: row?.sent_24h ?? 0,
    };
  }

  /** Emails that were given up on, newest first. No addresses: only type and appointment. */
  async listFailed(limit = 100): Promise<FailedEmail[]> {
    const rows = await this.prisma.notificationOutbox.findMany({
      where: { status: 'failed' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      appointmentId: (r.payload as unknown as AppointmentNotification).appointmentId ?? null,
      attempts: r.attempts,
      lastError: r.lastError,
      createdAt: r.createdAt.toISOString(),
      lastAttemptAt: r.nextAttemptAt.toISOString(),
    }));
  }

  /** Puts failed emails back in the queue with fresh attempts. Same keys: no duplicates. */
  async retryFailed(ids: string[] | 'all'): Promise<number> {
    if (ids === 'all') {
      return this.prisma.$executeRaw`
        UPDATE notification_outbox
        SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL
        WHERE status = 'failed'`;
    }
    return this.prisma.$executeRaw`
      UPDATE notification_outbox
      SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL
      WHERE status = 'failed' AND id = ANY(${ids}::uuid[])`;
  }

  /**
   * Logs an error and emails the platform administrators when emails failed or are
   * stuck. At most once an hour per server; the hourly idempotency key makes a
   * provider like Resend drop the copies sent by other servers.
   */
  async checkAlerts(now = Date.now()): Promise<boolean> {
    const stats = await this.stats();
    if (stats.status === 'ok') return false;
    if (now - this.lastAlertAt < ALERT_REPEAT_MS) return false;
    this.lastAlertAt = now;
    const summary = `Email queue: ${stats.problems.join(', ')} — failed ${stats.failed}, due ${stats.due}, oldest due ${Math.round(stats.oldestDueSeconds / 60)} min`;
    this.logger.error(summary);
    const hour = Math.floor(now / ALERT_REPEAT_MS);
    for (const to of this.config.PLATFORM_ADMIN_EMAILS) {
      try {
        await this.mail.send(
          {
            to,
            subject: 'Beauty Platform: problem with the email queue',
            text: `${summary}\n\nOpen ${this.config.APP_WEB_URL}/pl/app/admin/outbox to see and resend failed emails.`,
          },
          { idempotencyKey: `outbox-alert-${hour}-${to}` },
        );
      } catch (error) {
        this.logger.error(
          `Could not send the queue alert: ${maskEmails(error instanceof Error ? error.message : String(error))}`,
        );
      }
    }
    return true;
  }

  /** "Your points expire soon" to the client, from the salon; skipped when nothing is left. */
  private async renderPointsExpiring(row: ClaimedRow): Promise<MailMessage[] | null> {
    const payload = row.payload as unknown as PointsExpiringNotification;
    const account = await this.prisma.loyaltyAccount.findUnique({
      where: { id: payload.accountId },
      include: {
        customer: true,
        program: {
          include: {
            organization: {
              include: { locations: { orderBy: { createdAt: 'asc' }, take: 1 } },
            },
          },
        },
      },
    });
    const email = account?.customer.email;
    if (!account || !email || account.balance <= 0 || !account.program.enabled) return null;
    const organization = account.program.organization;
    const location = organization.locations[0];
    const salonName = location?.name ?? organization.name;
    const locale = account.customer.locale;
    const { subject, text } = renderPointsExpiringEmail(locale, {
      salonName,
      points: Math.min(payload.points, account.balance),
      expiresAt: new Date(payload.expiresAt),
      timeZone: location?.timezone ?? 'Europe/Warsaw',
    });
    return [
      {
        to: email,
        subject,
        text,
        lang: locale,
        senderName: salonName,
        ...(location?.email ? { replyTo: location.email } : {}),
      },
    ];
  }

  /** Builds the emails from current data; null = nothing to send any more. */
  private async render(row: ClaimedRow): Promise<MailMessage[] | null> {
    if (row.type === POINTS_EXPIRING) return this.renderPointsExpiring(row);
    const kind = row.type as NotificationKind;
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: row.payload.appointmentId },
      include: {
        location: true,
        service: true,
        staff: { include: { user: true } },
        customer: true,
      },
    });
    if (!appointment) return null;

    if (kind === 'client_reminder') {
      const stillValid =
        appointment.status === 'confirmed' &&
        appointment.version === row.payload.version &&
        appointment.startAt.getTime() > Date.now();
      if (!stillValid) return null;
    }

    const details = (locale: Locale, manageLink?: string) => ({
      salonName: appointment.location.name,
      address: `${appointment.location.addressLine}, ${appointment.location.postalCode} ${appointment.location.city}`,
      serviceName: appointment.service.name,
      staffName: appointment.staff.displayName,
      when: formatWhen(appointment.startAt, appointment.location.timezone, locale),
      price: formatPrice(appointment.priceGrosze, appointment.location.currency, locale),
      customerName: appointment.customer?.name ?? '',
      customerPhone: appointment.customer?.phone ?? '',
      manageLink,
      reason: row.payload.reason ?? null,
    });

    if (kind.startsWith('client_')) {
      const email = appointment.customer?.email;
      if (!email) return null;
      const locale = appointment.locale;
      let manageLink: string | undefined;
      if (kind !== 'client_cancelled') {
        // Only token hashes are stored, so a fresh link is created for each email.
        const token = generateToken();
        await this.prisma.appointmentAccessToken.create({
          data: {
            appointmentId: appointment.id,
            tokenHash: hashToken(token),
            expiresAt: new Date(
              appointment.startAt.getTime() + MANAGE_LINK_DAYS_AFTER_VISIT * DAY_MS,
            ),
          },
        });
        manageLink = `${this.config.APP_WEB_URL}/${locale}/m/${token}`;
      }
      const { subject, text } = renderAppointmentEmail(kind, locale, details(locale, manageLink));
      // From the salon's name; a reply reaches the salon, not the platform (launch task L2).
      return [
        {
          to: email,
          subject,
          text,
          lang: locale,
          senderName: appointment.location.name,
          ...(appointment.location.email ? { replyTo: appointment.location.email } : {}),
        },
      ];
    }

    // Salon notifications: owners, managers of this location and the staff member.
    const memberships = await this.prisma.membership.findMany({
      where: {
        organizationId: appointment.location.organizationId,
        status: 'active',
        OR: [
          { role: 'owner' },
          { role: 'manager', locations: { some: { locationId: appointment.locationId } } },
        ],
      },
      include: { user: true },
    });
    const users = [...memberships.map((m) => m.user), appointment.staff.user].filter(
      (u): u is NonNullable<typeof u> => u !== null && u.emailVerifiedAt !== null,
    );
    const unique = [...new Map(users.map((u) => [u.email, u])).values()];
    if (unique.length === 0) return null;
    return unique.map((user) => {
      const { subject, text } = renderAppointmentEmail(kind, user.locale, details(user.locale));
      return { to: user.email, subject, text, lang: user.locale };
    });
  }
}

/** Task 10f: a client's points expire soon (payload: PointsExpiringNotification). */
export const POINTS_EXPIRING = 'loyalty_points_expiring';

export interface PointsExpiringNotification {
  accountId: string;
  points: number;
  expiresAt: string;
}

/** Thrown by tests through `afterSend` to simulate the process dying mid-way. */
export class SimulatedCrash extends Error {}
