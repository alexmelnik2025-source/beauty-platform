import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { loadConfig } from './config/config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // JSON logs in production for log collectors; readable logs locally.
    logger: new ConsoleLogger({ json: config.NODE_ENV === 'production' }),
  });
  configureApp(app, { docs: config.NODE_ENV !== 'production' });
  if (config.TRUST_PROXY > 0) app.set('trust proxy', config.TRUST_PROXY);
  app.enableShutdownHooks();
  await app.listen(config.PORT);
  const logger = new Logger('Bootstrap');
  logger.log(`API listening on http://localhost:${config.PORT}/v1`);
  if (config.NODE_ENV !== 'production') {
    logger.log(`API docs: http://localhost:${config.PORT}/v1/docs`);
  }
}

void bootstrap();
