import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { generateToken, hashToken } from '../common/crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { Locale, Prisma } from '../generated/prisma/client';
import { MailService, type MailMessage } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  formatPrice,
  formatWhen,
  renderAppointmentEmail,
  type NotificationKind,
} from './booking-templates';

export interface AppointmentNotification {
  appointmentId: string;
  /** The appointment version the message is about; stale messages are skipped. */
  version: number;
  reason?: string | null;
}

const MAX_ATTEMPTS = 5;
const BATCH = 20;
const LOCK_SECONDS = 60;
const MANAGE_LINK_DAYS_AFTER_VISIT = 7;
const DAY_MS = 86_400_000;

interface ClaimedRow {
  id: string;
  type: string;
  payload: AppointmentNotification;
  attempts: number;
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
    return expired;
  }

  /**
   * Sends due messages. Returns how many rows were processed.
   * `afterSend` is a test hook that simulates a crash right after sending.
   */
  async drain(options: { afterSend?: () => void } = {}): Promise<number> {
    let processed = 0;
    for (;;) {
      const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
        UPDATE notification_outbox
        SET locked_until = now() + make_interval(secs => ${LOCK_SECONDS}::int), attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM notification_outbox
          WHERE status = 'pending' AND next_attempt_at <= now()
            AND (locked_until IS NULL OR locked_until < now())
          ORDER BY next_attempt_at
          LIMIT ${BATCH}::int
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, type, payload, attempts`;
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
    const message = error instanceof Error ? error.message : String(error);
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

  /** Builds the emails from current data; null = nothing to send any more. */
  private async render(row: ClaimedRow): Promise<MailMessage[] | null> {
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
      price: formatPrice(appointment.priceGrosze, locale),
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
      return [{ to: email, subject, text }];
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
      return { to: user.email, subject, text };
    });
  }
}

/** Thrown by tests through `afterSend` to simulate the process dying mid-way. */
export class SimulatedCrash extends Error {}
