import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';

const DB_CHECK_TIMEOUT_MS = 2000;

export interface HealthResponse {
  status: 'ok' | 'error';
  checks: { database: 'up' | 'down' };
  time: string;
}

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness and database connectivity. 200 when healthy, 503 otherwise. */
  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const databaseUp = await this.isDatabaseUp();
    if (!databaseUp) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return {
      status: databaseUp ? 'ok' : 'error',
      checks: { database: databaseUp ? 'up' : 'down' },
      time: new Date().toISOString(),
    };
  }

  private async isDatabaseUp(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), DB_CHECK_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.prisma.$queryRaw`SELECT 1`, timeout]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
