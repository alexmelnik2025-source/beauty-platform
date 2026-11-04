import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { POINTS_EXPIRING, type PointsExpiringNotification } from '../booking/outbox.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoyaltyLedger } from './loyalty-ledger';

const EVERY_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
/** Clients with an email hear a week before their points expire (once for each date). */
export const WARN_DAYS = 7;

/**
 * Takes points past their date off clients' balances (task 10f), once an hour on every
 * server that runs the background workers (OUTBOX_POLL_MS > 0). Each account is handled in
 * its own transaction with its row locked, so several servers never expire the same points
 * twice; tests call `run` directly.
 */
@Injectable()
export class LoyaltyExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('LoyaltyExpiry');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LoyaltyLedger,
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
      const { accounts, points, warned } = await this.run();
      if (points > 0 || warned > 0) {
        this.logger.log(`Expired ${points} points on ${accounts} accounts, warned ${warned}`);
      }
    } catch (error) {
      this.logger.error(`Expiry failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Expires what is due now on every account that has points with a passed date, then queues
   * "your points expire soon" for clients whose points expire within a week.
   */
  async run(now = new Date()): Promise<{ accounts: number; points: number; warned: number }> {
    const candidates = await this.prisma.loyaltyAccount.findMany({
      where: {
        balance: { gt: 0 },
        transactions: { some: { expiresAt: { lte: now }, points: { gt: 0 } } },
      },
      select: { id: true },
    });
    let accounts = 0;
    let points = 0;
    for (const { id } of candidates) {
      const expired = await this.prisma.$transaction((tx) => this.ledger.expireDue(tx, id, now));
      if (expired > 0) {
        accounts += 1;
        points += expired;
      }
    }
    return { accounts, points, warned: await this.warn(now) };
  }

  /** One email for each account and expiry date; the email queue sends it from the salon. */
  private async warn(now: Date): Promise<number> {
    const until = new Date(now.getTime() + WARN_DAYS * DAY_MS);
    const soon: Prisma.LoyaltyTransactionWhereInput = {
      expiresAt: { gt: now, lte: until },
      points: { gt: 0 },
      type: { in: ['earn', 'adjust'] },
      reversedBy: { is: null },
    };
    const candidates = await this.prisma.loyaltyAccount.findMany({
      where: {
        balance: { gt: 0 },
        customer: { email: { not: null } },
        program: { enabled: true, mode: 'points' },
        transactions: { some: soon },
      },
      select: {
        id: true,
        balance: true,
        transactions: { where: soon, orderBy: { expiresAt: 'asc' }, take: 1 },
      },
    });
    let warned = 0;
    for (const account of candidates) {
      const first = account.transactions[0]?.expiresAt;
      if (!first) continue;
      const points = await this.ledger.dueBy(this.prisma, account.id, account.balance, until);
      if (points <= 0) continue;
      const payload: PointsExpiringNotification = {
        accountId: account.id,
        points,
        expiresAt: first.toISOString(),
      };
      const created = await this.prisma.notificationOutbox.createMany({
        data: [
          {
            type: POINTS_EXPIRING,
            payload: payload as unknown as Prisma.InputJsonValue,
            dedupeKey: `${POINTS_EXPIRING}:${account.id}:${first.toISOString().slice(0, 10)}`,
          },
        ],
        skipDuplicates: true,
      });
      warned += created.count;
    }
    return warned;
  }
}
