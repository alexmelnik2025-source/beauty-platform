import { createHash } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, Observable, of } from 'rxjs';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from './app-exception';
import type { AppRequest } from './request-context';

const IDEMPOTENT = 'idempotent';
const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Marks a write endpoint that accepts an `Idempotency-Key` header. Mobile apps send
 * one per user action; if the connection drops and the request is retried with the
 * same key, the stored response is returned instead of doing the action twice.
 */
export const Idempotent = (): MethodDecorator => SetMetadata(IDEMPOTENT, true);

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.reflector.get<boolean>(IDEMPOTENT, context.getHandler())) return next.handle();
    const request = context.switchToHttp().getRequest<AppRequest>();
    const key = request.header('idempotency-key');
    if (!key) return next.handle();
    return from(this.handle(request, key, next));
  }

  private async handle(request: AppRequest, key: string, next: CallHandler): Promise<unknown> {
    if (!KEY.test(key)) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'Idempotency-Key must be 8–100 letters, digits, - or _',
      );
    }
    const who = request.auth?.userId ?? `anonymous:${request.ip}`;
    const scope = `${who} ${request.method} ${request.path}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(request.body ?? {}))
      .digest('hex');

    await this.prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const claimed = await this.prisma.idempotencyKey
      .create({ data: { scope, key, requestHash, expiresAt: new Date(Date.now() + TTL_MS) } })
      .then(() => true)
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === 'P2002') return false;
        throw error;
      });

    if (!claimed) {
      const existing = await this.prisma.idempotencyKey.findUnique({
        where: { scope_key: { scope, key } },
      });
      if (!existing) return lastValueFrom(next.handle());
      if (existing.requestHash !== requestHash) {
        throw new AppException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was used for a different request',
        );
      }
      if (!existing.completed) {
        throw new AppException(
          HttpStatus.CONFLICT,
          'REQUEST_IN_PROGRESS',
          'The same request is still being processed',
        );
      }
      return lastValueFrom(of(existing.responseBody));
    }

    try {
      const body = await lastValueFrom(next.handle());
      await this.prisma.idempotencyKey.update({
        where: { scope_key: { scope, key } },
        data: {
          completed: true,
          responseBody:
            body === undefined || body === null ? Prisma.JsonNull : (body as Prisma.InputJsonValue),
        },
      });
      return body;
    } catch (error) {
      // A failed request may be retried for real.
      await this.prisma.idempotencyKey.deleteMany({ where: { scope, key } });
      throw error;
    }
  }
}
