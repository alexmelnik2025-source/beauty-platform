import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

/** Database work done while answering one request. */
interface TimingStore {
  dbQueries: number;
  dbMs: number;
}

const storage = new AsyncLocalStorage<TimingStore>();

/** Called by PrismaService for every SQL query; counts it towards the current request. */
export function recordDbQuery(durationMs: number): void {
  const store = storage.getStore();
  if (!store) return;
  store.dbQueries += 1;
  store.dbMs += durationMs;
}

export interface RequestTiming {
  method: string;
  path: string;
  status: number;
  totalMs: number;
  dbQueries: number;
  dbMs: number;
}

/** A request slower than this is logged as a warning (local target: < 300 ms). */
export const SLOW_REQUEST_MS = 300;

export function formatTiming(t: RequestTiming): string {
  return `${t.method} ${t.path} ${t.status} ${t.totalMs} ms (db: ${t.dbQueries} queries, ${t.dbMs} ms)`;
}

/**
 * Local development only: measures every request, logs one line per request and adds a
 * Server-Timing header, so the browser's Network tab shows how long the API itself took
 * (and how much of that was the database) apart from the web server in front of it.
 */
export function requestTimingMiddleware(
  report: (timing: RequestTiming) => void,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    const store: TimingStore = { dbQueries: 0, dbMs: 0 };
    const elapsedMs = (): number => Number((process.hrtime.bigint() - started) / 1_000_000n);

    const writeHead = res.writeHead;
    res.writeHead = function (this: Response, ...args: unknown[]) {
      if (!res.headersSent) {
        res.setHeader(
          'Server-Timing',
          `api;dur=${elapsedMs()}, db;dur=${Math.round(store.dbMs)};desc="${store.dbQueries} queries"`,
        );
      }
      return (writeHead as (...a: unknown[]) => Response).apply(this, args);
    } as Response['writeHead'];

    res.on('finish', () => {
      report({
        method: req.method,
        path: req.originalUrl.split('?')[0] ?? req.originalUrl,
        status: res.statusCode,
        totalMs: elapsedMs(),
        dbQueries: store.dbQueries,
        dbMs: Math.round(store.dbMs),
      });
    });

    storage.run(store, next);
  };
}
