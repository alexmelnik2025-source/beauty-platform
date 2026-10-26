import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { Locale } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { pushMessage } from './push-texts';
import { PushGoneError, PushSender } from './push.sender';

const base64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+=*$/)
  .min(8)
  .max(256);

export const subscribeSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  keys: z.object({ p256dh: base64url, auth: base64url }),
});
export type SubscribeInput = z.infer<typeof subscribeSchema>;

export const unsubscribeSchema = z.object({ endpoint: z.string().min(1).max(2048) });
export type UnsubscribeInput = z.infer<typeof unsubscribeSchema>;

/** A notification is tried at most this many times. */
const MAX_ATTEMPTS = 3;
/** Older notifications are not pushed any more (the feed still has them). */
const PUSH_WINDOW_MINUTES = 60;
const BATCH = 50;

interface ClaimedNotification {
  id: string;
  user_id: string;
  type: string;
  appointment_id: string | null;
  data: unknown;
}

/**
 * Push messages about appointments to the apps of the people in the salon.
 *
 * The notification feed is the source: every feed row is written in the same transaction
 * as the change, and this worker pushes rows that are not pushed yet. So a push goes out
 * only for a committed change, and a crashed server does not lose it (it is retried).
 * Only rows of the last hour are pushed — a late "new booking" is noise.
 */
@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Push');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: PushSender,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.sender.publicKey === null) {
      this.logger.log('Push is off: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not set');
      return;
    }
    if (this.config.OUTBOX_POLL_MS > 0) {
      this.timer = setInterval(() => void this.tick(), this.config.OUTBOX_POLL_MS);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  publicKey(): { publicKey: string | null } {
    return { publicKey: this.sender.publicKey };
  }

  /** Saves this device for push. The same device signed in as someone else moves to them. */
  async subscribe(userId: string, input: SubscribeInput, userAgent?: string): Promise<void> {
    const data = {
      userId,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: userAgent?.slice(0, 300) ?? null,
    };
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: { endpoint: input.endpoint, ...data },
      update: data,
    });
  }

  /** Stops push on this device (own devices only). */
  async unsubscribe(userId: string, input: UnsubscribeInput): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint: input.endpoint },
    });
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.deliver();
    } catch (error) {
      this.logger.error('Push cycle failed', error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }

  /** Pushes what is due. Returns how many notifications were handled. */
  async deliver(): Promise<number> {
    if (this.sender.publicKey === null) return 0;
    let handled = 0;
    for (;;) {
      // SKIP LOCKED: several API servers never push the same notification at once.
      const rows = await this.prisma.$queryRaw<ClaimedNotification[]>`
        UPDATE notification SET push_attempts = push_attempts + 1
        WHERE id IN (
          SELECT n.id FROM notification n
          WHERE n.pushed_at IS NULL
            AND n.push_attempts < ${MAX_ATTEMPTS}
            AND n.created_at > now() - make_interval(mins => ${PUSH_WINDOW_MINUTES}::int)
            AND EXISTS (SELECT 1 FROM push_subscription s WHERE s.user_id = n.user_id)
            AND EXISTS (
              SELECT 1 FROM membership m
              WHERE m.user_id = n.user_id AND m.organization_id = n.organization_id
                AND m.status = 'active'
            )
          ORDER BY n.id
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, user_id, type, appointment_id, data`;
      if (rows.length === 0) return handled;
      for (const row of rows) {
        handled += 1;
        if (await this.pushOne(row)) {
          await this.prisma.notification.update({
            where: { id: row.id },
            data: { pushedAt: new Date() },
          });
        }
      }
      if (rows.length < BATCH) return handled;
    }
  }

  /** Sends one notification to every device of its user. True = done (no retry needed). */
  private async pushOne(row: ClaimedNotification): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: row.user_id },
      select: { locale: true, pushSubscriptions: true },
    });
    if (!user) return true;
    const message = pushMessage(user.locale as Locale, {
      type: row.type,
      appointmentId: row.appointment_id,
      data: row.data,
    });
    let failed = 0;
    for (const subscription of user.pushSubscriptions) {
      try {
        await this.sender.send(subscription, message);
        await this.prisma.pushSubscription.update({
          where: { id: subscription.id },
          data: { lastSuccessAt: new Date() },
        });
      } catch (error) {
        if (error instanceof PushGoneError) {
          await this.prisma.pushSubscription.deleteMany({ where: { id: subscription.id } });
        } else {
          failed += 1;
        }
      }
    }
    // Retry later only if some device could not be reached for a temporary reason.
    return failed === 0;
  }
}
