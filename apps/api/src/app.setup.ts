import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { buildOpenApiDocument } from './common/openapi';
import { requestIdMiddleware } from './common/request-id.middleware';
import { requestTimingMiddleware, type RequestTiming } from './common/request-timing';

/** HTTP settings shared by the real server and the tests. */
export function configureApp(
  app: NestExpressApplication,
  options: {
    docs: boolean;
    /** Local development: time every request (log line + Server-Timing header). */
    timing?: (timing: RequestTiming) => void;
  },
): void {
  app.disable('x-powered-by');
  if (options.timing) app.use(requestTimingMiddleware(options.timing));
  app.use(requestIdMiddleware);
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new HttpExceptionFilter());

  if (options.docs) {
    const document = buildOpenApiDocument(app);
    // Interactive docs at /v1/docs, raw OpenAPI JSON at /v1/docs-json.
    SwaggerModule.setup('v1/docs', app, document, { jsonDocumentUrl: 'v1/docs-json' });
  }
}
