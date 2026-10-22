import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { requestIdMiddleware } from './common/request-id.middleware';

/** HTTP settings shared by the real server and the tests. */
export function configureApp(app: NestExpressApplication, options: { docs: boolean }): void {
  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new HttpExceptionFilter());

  if (options.docs) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Beauty Platform API')
        .setDescription(
          'One API for the owner web app and the iOS/Android apps. Errors: { error: { code, message, requestId } }.',
        )
        .setVersion('v1')
        .addBearerAuth()
        .build(),
    );
    // Interactive docs at /v1/docs, raw OpenAPI JSON at /v1/docs-json.
    SwaggerModule.setup('v1/docs', app, document, { jsonDocumentUrl: 'v1/docs-json' });
  }
}
