import { HttpException, HttpStatus } from '@nestjs/common';

export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * An error with a stable machine-readable code (e.g. INVALID_CREDENTIALS).
 * Web and mobile clients translate the code; `message` is for developers.
 */
export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message, status);
  }
}

/** Returned instead of 403 for anything outside the caller's organization, so ids cannot be probed. */
export const notFound = (what = 'Resource'): AppException =>
  new AppException(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`);

export const forbidden = (): AppException =>
  new AppException(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Your role does not allow this action');
