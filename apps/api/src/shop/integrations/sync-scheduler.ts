import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { BaseOrdersService } from './base-orders.service';
import { ShopIntegrationsService } from './integrations.service';

/** How often the scheduler looks for integrations due a renewal (each has its own period). */
const EVERY_MS = 5 * 60_000;

/**
 * Task Q4 (part 2): on servers that run the background workers, every 5 minutes renews prices and
 * stock from Base for the integrations whose `syncEveryMinutes` has passed. Tests call
 * `ShopIntegrationsService.syncDue` directly. Task Q4 (part 5): first sends products put aside
 * to Base as orders (`BaseOrdersService.pushDue`).
 */
@Injectable()
export class ShopSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ShopSync');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly integrations: ShopIntegrationsService,
    private readonly orders: BaseOrdersService,
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
      // Orders first (task Q4, part 5): what failed before, and visits cancelled meanwhile.
      const sent = await this.orders.pushDue();
      if (sent > 0) this.logger.log(`Sent orders to Base for ${sent} seller(s)`);
      const ran = await this.integrations.syncDue();
      if (ran > 0) this.logger.log(`Renewed prices and stock of ${ran} seller(s) from Base`);
    } catch (error) {
      this.logger.error(`Failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.running = false;
    }
  }
}
