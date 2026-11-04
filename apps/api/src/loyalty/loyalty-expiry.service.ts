import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { LoyaltyLedger } from './loyalty-ledger';

const EVERY_MS = 60 * 60_000;

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
      const { accounts, points } = await this.run();
      if (points > 0) this.logger.log(`Expired ${points} points on ${accounts} accounts`);
    } catch (error) {
      this.logger.error(`Expiry failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.running = false;
    }
  }

  /** Expires what is due now on every account that has points with a passed date. */
  async run(now = new Date()): Promise<{ accounts: number; points: number }> {
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
    return { accounts, points };
  }
}
