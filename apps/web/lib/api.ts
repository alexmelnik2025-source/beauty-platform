/**
 * Browser client for the API. The web server passes /v1/* on to the API, so
 * requests are same-origin and the refresh cookie (httpOnly) works without CORS.
 * The access token lives in memory only; on 401 it is renewed once via the cookie.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const authListeners = new Set<(signedIn: boolean) => void>();

export function setAccessToken(token: string | null): void {
  accessToken = token;
  for (const listener of authListeners) listener(token !== null);
}

export function onAuthChange(listener: (signedIn: boolean) => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

/** True while an access token is in memory (it is renewed on 401 anyway). */
export function hasAccessToken(): boolean {
  return accessToken !== null;
}

/** Gets a new access token from the refresh cookie. One request at a time. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        credentials: 'same-origin',
        // Task 204: a page load in the middle must not drop the answer - the server has already
        // rotated the cookie, and the old one would then count as stolen (the session ends).
        keepalive: true,
      });
      if (!res.ok) {
        setAccessToken(null);
        return false;
      }
      const body = (await res.json()) as { accessToken: string };
      setAccessToken(body.accessToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** A file sent as is (photos): its own type, not JSON. */
  file?: Blob;
  query?: Record<string, string | number | boolean | undefined>;
  /** Send the access token (default true). */
  auth?: boolean;
  /** Creates and changes from a phone may be retried: same key → same result. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

function url(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.file) headers['Content-Type'] = options.file.type;
  else if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  try {
    return await fetch(url(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body: options.file ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error');
  }
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    return new ApiError(
      res.status,
      body.error?.code ?? 'INTERNAL_ERROR',
      body.error?.message ?? res.statusText,
      body.error?.details,
    );
  } catch {
    return new ApiError(res.status, 'INTERNAL_ERROR', res.statusText);
  }
}

/** Full response (for ETag / 304 handling). Throws ApiError for 4xx/5xx except 304. */
export async function apiResponse(path: string, options: RequestOptions = {}): Promise<Response> {
  let res = await send(path, options);
  if (res.status === 401 && options.auth !== false && (await refreshSession())) {
    res = await send(path, options);
  }
  if (!res.ok && res.status !== 304) throw await toError(res);
  return res;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await apiResponse(path, options);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
