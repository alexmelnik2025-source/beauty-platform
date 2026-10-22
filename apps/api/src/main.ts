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
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(config.PORT);
  new Logger('Bootstrap').log(`API listening on http://localhost:${config.PORT}/v1`);
}

void bootstrap();
