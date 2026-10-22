import { HttpStatus, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { AppException } from './app-exception';

/** Validates and normalises input on the server with a zod schema (shared later with clients). */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) {
      return result.data;
    }
    throw new AppException(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      'Request validation failed',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
}
