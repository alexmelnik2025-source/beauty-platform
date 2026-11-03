import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { recordDbQuery } from '../common/request-timing';

/** The part of Prisma's event API used here (the client type does not know the log option). */
interface QueryEvents {
  $on(event: 'query', listener: (event: { duration: number }) => void): void;
}

/**
 * Database access. Connects lazily on the first query, so the API can start
 * (and report the problem via /v1/health) even when the database is down.
 * Every query is counted towards the current request (request timing in development).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({
      adapter: new PrismaPg({ connectionString: config.DATABASE_URL }),
      log: [{ emit: 'event', level: 'query' }],
    });
    (this as unknown as QueryEvents).$on('query', (event) => recordDbQuery(Number(event.duration)));
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
