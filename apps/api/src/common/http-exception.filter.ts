import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException } from './app-exception';

/**
 * Single error format for every client (web and mobile):
 * { "error": { "code": "NOT_FOUND", "message": "...", "requestId": "...", "details"?: [...] } }
 * `code` is machine-readable; clients translate it into the user's language.
 * Unexpected errors never leak internal details.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = response.getHeader('x-request-id')?.toString();

    if (exception instanceof AppException) {
      response.status(exception.getStatus()).json({
        error: {
          code: exception.code,
          message: exception.message,
          requestId,
          ...(exception.details ? { details: exception.details } : {}),
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json({
        error: { code: codeFor(status), message: exception.message, requestId },
      });
      return;
    }

    this.logger.error(
      `Unhandled error on ${request.method} ${request.path} (requestId=${requestId})`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId },
    });
  }
}

function codeFor(status: number): string {
  const name = HttpStatus[status];
  return typeof name === 'string' ? name : 'HTTP_ERROR';
}
