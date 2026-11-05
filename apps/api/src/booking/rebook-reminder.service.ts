import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { notFound } from '../common/app-exception';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  customerFromToken,
  DAY_MS,
  REBOOK_REMINDER,
  REBOOK_WINDOW_DAYS,
  rebookCandidate,
  type RebookReminderNotification,
} from './rebook-reminder';

const EVERY_MS = 60 * 60_000;

/**
 * Task 165c: once an hour (on servers that run the background workers) queues "time for
 * your next visit" for visits that ended `rebookReminderDays` ago in salons that switched it
 * on — at most one email per visit (the queue's dedupe key). Tests call `run` directly.
 */
@Injectable()
export class RebookReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RebookReminder');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.OUTBOX_POLL_MS > 0) {
      this.timer = setInterval(() => void this.tick(), EVERY_MS);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const queued = await this.run();
      if (queued > 0) this.logger.log(`Queued ${queued} "time for your next visit" emails`);
    } catch (error) {
      this.logger.error(`Failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.running = false;
    }
  }

  /** Queues the emails due now; returns how many were queued. */
  async run(now = new Date()): Promise<number> {
    const locations = await this.prisma.location.findMany({
      where: { rebookReminderDays: { gt: 0 } },
      select: { id: true, rebookReminderDays: true },
    });
    let queued = 0;
    for (const location of locations) {
      const due = now.getTime() - location.rebookReminderDays * DAY_MS;
      const visits = await this.prisma.appointment.findMany({
        where: {
          locationId: location.id,
          status: { in: ['completed', 'confirmed'] },
          endAt: { lte: new Date(due), gt: new Date(due - REBOOK_WINDOW_DAYS * DAY_MS) },
          customer: { email: { not: null }, anonymizedAt: null },
        },
        select: { id: true },
      });
      for (const { id } of visits) {
        if (!(await rebookCandidate(this.prisma, id, now))) continue;
        const payload: RebookReminderNotification = { appointmentId: id };
        const created = await this.prisma.notificationOutbox.createMany({
          data: [
            {
              type: REBOOK_REMINDER,
              payload: payload as unknown as Prisma.InputJsonValue,
              dedupeKey: `${REBOOK_REMINDER}:${id}`,
            },
          ],
          skipDuplicates: true,
        });
        queued += created.count;
      }
    }
    return queued;
  }

  /**
   * The "unsubscribe" link of the email: withdraws the client's marketing consent in that
   * salon (a new consent record, the history stays). Clicking it twice changes nothing more.
   */
  async unsubscribe(token: string, ip: string | null): Promise<{ salonName: string }> {
    const customerId = customerFromToken(this.config.JWT_ACCESS_SECRET, token);
    if (!customerId) throw notFound('Link');
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        organization: {
          include: { locations: { orderBy: { createdAt: 'asc' }, take: 1 } },
        },
      },
    });
    if (!customer) throw notFound('Link');
    const last = await this.prisma.consentRecord.findFirst({
      where: { customerId, type: 'marketing' },
      orderBy: { createdAt: 'desc' },
    });
    if (last?.granted) {
      await this.prisma.consentRecord.create({
        data: {
          customerId,
          type: 'marketing',
          version: 'unsubscribe-link',
          granted: false,
          ip,
        },
      });
    }
    return {
      salonName: customer.organization.locations[0]?.name ?? customer.organization.name,
    };
  }
}
