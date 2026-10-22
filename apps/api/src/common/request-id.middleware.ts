import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const VALID_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Gives every request an id (or keeps a valid one from the client) for tracing in logs. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', id);
  next();
}
