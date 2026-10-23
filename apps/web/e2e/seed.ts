import { expect, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { waitForEmail } from './mailpit';

/** Helpers that build a salon through the real API, as an owner would. */

export const PASSWORD = 'e2e-password-123';
export type Headers = { Authorization: string };

export async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** Registers, confirms the email from Mailpit and signs in (mobile client: token in body). */
export async function verifiedUser(
  api: APIRequestContext,
  email: string,
  name: string,
): Promise<Headers> {
  await json(await api.post('/v1/auth/register', { data: { email, password: PASSWORD, name } }));
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', { data: { email, password: PASSWORD, clientType: 'mobile' } }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
}

/** Local date in Warsaw, `offset` days from today. */
export function warsawDate(offset: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

/** ISO instant of a Warsaw wall-clock time (Warsaw is UTC+1 or UTC+2). */
export function warsawInstant(date: string, time: string): string {
  for (const offset of ['+01:00', '+02:00']) {
    const iso = `${date}T${time}:00${offset}`;
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Warsaw',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));
    if (local === time) return new Date(iso).toISOString();
  }
  throw new Error(`No such time in Warsaw: ${date} ${time}`);
}

/**
 * Fails when the page can be scrolled sideways (a phone layout must fit the
 * screen; scrolling inside the calendar grid is fine, the page itself is not).
 */
export async function expectNoSidewaysScroll(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label}: page scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
}

/** Books online through the public API: hold → code from Mailpit → confirm. */
export async function bookOnline(
  api: APIRequestContext,
  slug: string,
  serviceId: string,
  staffId: string,
  start: string,
  client: { name: string; phone: string; email: string },
): Promise<void> {
  const hold = await json<{ holdId: string; holdToken: string }>(
    await api.post(`/v1/public/locations/${slug}/holds`, { data: { serviceId, staffId, start } }),
  );
  await json(
    await api.post(`/v1/public/holds/${hold.holdId}/code`, {
      data: { holdToken: hold.holdToken, ...client, locale: 'pl', acceptTerms: true },
    }),
  );
  const mail = await waitForEmail(client.email, /Kod potwierdzenia/);
  const code = /\b(\d{6})\b/.exec(mail.text)![1]!;
  await json(
    await api.post(`/v1/public/holds/${hold.holdId}/confirm`, {
      data: { holdToken: hold.holdToken, code },
    }),
  );
}
