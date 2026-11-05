import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
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
    /**
     * Browser pages on other addresses that may call the API: `any` in development (the phone
     * apps' web preview at http://localhost:8081 or http://<Mac's IP>:8081), otherwise the
     * listed origins (CORS_ORIGINS). Nothing = no CORS headers (the web app is same-origin).
     */
    cors?: 'any' | string[];
  },
): void {
  app.disable('x-powered-by');
  const cors = options.cors;
  if (cors === 'any' || (cors && cors.length > 0)) {
    app.enableCors({
      origin: cors === 'any' ? true : cors,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      // Authorization (Bearer token), Content-Type, Idempotency-Key, If-Match… are echoed back.
      credentials: false,
      exposedHeaders: [
        'Content-Disposition',
        'ETag',
        'Retry-After',
        'Server-Timing',
        'X-Request-Id',
      ],
      maxAge: 600,
    });
  }
  if (options.timing) app.use(requestTimingMiddleware(options.timing));
  app.use(requestIdMiddleware);
  // Answers are personal and change often: browsers must not keep them (T2: the service
  // list looked unchanged after an edit). Routes that may be cached (photos, calendar ETag)
  // set their own header.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new HttpExceptionFilter());

  if (options.docs) {
    const document = buildOpenApiDocument(app);
    // Interactive docs at /v1/docs, raw OpenAPI JSON at /v1/docs-json.
    SwaggerModule.setup('v1/docs', app, document, { jsonDocumentUrl: 'v1/docs-json' });
  }
}
