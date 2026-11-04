import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { loadConfig } from './config/config';
import { formatTiming, SLOW_REQUEST_MS } from './common/request-timing';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // JSON logs in production for log collectors; readable logs locally.
    logger: new ConsoleLogger({ json: config.NODE_ENV === 'production' }),
  });
  const http = new Logger('HTTP');
  configureApp(app, {
    docs: config.NODE_ENV !== 'production',
    // Local development: one line per request with its time and database share.
    timing:
      config.NODE_ENV === 'development'
        ? (timing) => {
            if (timing.totalMs >= SLOW_REQUEST_MS) http.warn(`slow: ${formatTiming(timing)}`);
            else http.log(formatTiming(timing));
          }
        : undefined,
  });
  if (config.TRUST_PROXY > 0) app.set('trust proxy', config.TRUST_PROXY);
  app.enableShutdownHooks();
  // No host: Node listens on every interface (IPv4 and IPv6), so a phone in the same Wi-Fi
  // reaches the API at http://<Mac's address>:4000 (pnpm mobile:client / mobile:business).
  await app.listen(config.PORT);
  const logger = new Logger('Bootstrap');
  logger.log(`API listening on http://localhost:${config.PORT}/v1`);
  if (config.NODE_ENV !== 'production') {
    logger.log(`API docs: http://localhost:${config.PORT}/v1/docs`);
  }
}

void bootstrap();
