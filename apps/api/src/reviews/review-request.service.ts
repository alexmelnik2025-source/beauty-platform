import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  REQUEST_WINDOW_HOURS,
  REVIEW_REQUEST,
  reviewRequestCandidate,
  type ReviewRequestNotification,
} from './review-request';

const EVERY_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;

/**
 * Task 165b, part 2: every 15 minutes (on servers that run the background workers) queues
 * "How was your visit?" for visits that ended `requestHours` ago in salons that collect
 * reviews — at most one email per visit (the queue's dedupe key). Tests call `run` directly.
 */
@Injectable()
export class ReviewRequestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ReviewRequest');
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
      if (queued > 0) this.logger.log(`Queued ${queued} "how was your visit" emails`);
    } catch (error) {
      this.logger.error(`Failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.running = false;
    }
  }

  /** Queues the emails due now; returns how many were queued. */
  async run(now = new Date()): Promise<number> {
    const salons = await this.prisma.reviewSettings.findMany({
      where: { enabled: true },
      select: { locationId: true, requestHours: true },
    });
    let queued = 0;
    for (const salon of salons) {
      const due = now.getTime() - salon.requestHours * HOUR_MS;
      const visits = await this.prisma.appointment.findMany({
        where: {
          locationId: salon.locationId,
          status: { in: ['completed', 'confirmed'] },
          endAt: { lte: new Date(due), gt: new Date(due - REQUEST_WINDOW_HOURS * HOUR_MS) },
          review: null,
          customer: { email: { not: null }, anonymizedAt: null },
        },
        select: { id: true },
      });
      for (const { id } of visits) {
        if (!(await reviewRequestCandidate(this.prisma, id, now))) continue;
        const payload: ReviewRequestNotification = { appointmentId: id };
        const created = await this.prisma.notificationOutbox.createMany({
          data: [
            {
              type: REVIEW_REQUEST,
              payload: payload as unknown as Prisma.InputJsonValue,
              dedupeKey: `${REVIEW_REQUEST}:${id}`,
            },
          ],
          skipDuplicates: true,
        });
        queued += created.count;
      }
    }
    return queued;
  }
}
