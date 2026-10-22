import type { NestExpressApplication } from '@nestjs/platform-express';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { requestIdMiddleware } from './common/request-id.middleware';

/** HTTP settings shared by the real server and the tests. */
export function configureApp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new HttpExceptionFilter());
}
