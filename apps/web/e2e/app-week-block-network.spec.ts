import { expect, test as base, type APIResponse, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { addDays, dayTitle, todayIn } from '../../mobile-business/src/day';
import { weekStart } from '../../mobile-business/src/week';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

async function json<T>(response: APIResponse): Promise<T> {
  await expect(response).toBeOK();
  return response.json();
}

const test = base.extend<{
  salon: { path: string; headers: Record<string, string>; today: string };
}>({
  salon: async ({ request, page }, use) => {
    const address = freshAddress();
    const credentials = { email: `ck-${randomUUID()}@example.com`, password: randomUUID() };
    await expect(
      await request.post('/v1/auth/register', {
        headers: address,
        data: { ...credentials, name: 'Anna Nowak' },
      }),
    ).toBeOK();
    const mail = await waitForEmail(credentials.email, /Potwierdź adres/);
    const token = /token=([^\s&]+)/.exec(mail.text)![1]!;
    await expect(
      await request.post('/v1/auth/verify-email', {
        headers: address,
        data: { token: decodeURIComponent(token) },
      }),
    ).toBeOK();
    const { accessToken, refreshToken } = await json<{ accessToken: string; refreshToken: string }>(
      await request.post('/v1/auth/login', {
        headers: address,
        data: { ...credentials, clientType: 'mobile' },
      }),
    );
    const headers = { ...address, Authorization: `Bearer ${accessToken}` };
    const org = await json<{ id: string }>(
      await request.post('/v1/organizations', {
        headers,
        data: { name: 'Studio CK' },
      }),
    );
    const locations = `/v1/organizations/${org.id}/locations`;
    const location = await json<{ id: string }>(
      await request.post(locations, {
        headers,
        data: {
          name: 'Studio CK',
          addressLine: 'Testowa 1',
          city: 'Warszawa',
          postalCode: '00-001',
        },
      }),
    );
    const app = await serveApp('mobile-business');
    try {
      const now = new Date();
      await page.clock.setFixedTime(now);
      await page.setExtraHTTPHeaders(address);
      await page.addInitScript(
        (value) => localStorage.setItem('beauty.business.refreshToken', value),
        refreshToken,
      );
      await page.goto(app.url);
      await expect(page.getByRole('button', { name: 'Tydzień', exact: true })).toBeVisible();
      await use({
        path: `${locations}/${location.id}`,
        headers,
        today: todayIn('Europe/Warsaw', now),
      });
    } finally {
      app.server.close();
    }
  },
});
test.use({
  viewport: { width: 320, height: 844 },
  isMobile: true,
  locale: 'pl-PL',
  timezoneId: 'Europe/Warsaw',
});

// Hold one real request until the test releases it, independently of server speed.
async function holdNext(page: Page, url: string) {
  let capture!: (route: Route) => void;
  const pending = new Promise<Route>((resolve) => {
    capture = resolve;
  });
  await page.route(url, capture, { times: 1 });
  return { pending };
}

test('week retries the selected range and keeps the last displayed days after a failure or late response', async ({
  page,
  salon,
}) => {
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const monday = weekStart(salon.today);
  const range = (from: string) => `**${salon.path}/calendar?from=${from}&to=${addDays(from, 6)}`;
  const expectWeek = async (from: string) => {
    await expect(
      page.getByLabel(`${dayTitle(from, 'pl')} – ${dayTitle(addDays(from, 6), 'pl')}`, {
        exact: true,
      }),
    ).toBeVisible();
    for (let i = 0; i < 7; i++) {
      const title = dayTitle(addDays(from, i), 'pl');
      await expect(page.getByRole('button', { name: new RegExp('^' + title) })).toBeVisible();
    }
  };
  const alert = page.getByRole('alert');
  await page.route(range(monday), (route) => route.abort(), { times: 1 });
  await button('Tydzień').click();
  await expect(alert).toContainText('Brak połączenia');
  await button('Odśwież').click();
  await expectWeek(monday);

  const next = addDays(monday, 7);
  await page.route(range(next), (route) => route.abort(), { times: 1 });
  await button('Następny tydzień').click();
  await expect(alert).toContainText('Brak połączenia');
  await expectWeek(monday);

  const slow = await holdNext(page, range(next));
  await button('Odśwież').click();
  const delayed = await slow.pending;
  await expectWeek(monday);
  await button('Następny tydzień').click();
  const latest = addDays(next, 7);
  await expectWeek(latest);
  const finished = page.waitForEvent('requestfinished', (req) => req === delayed.request());
  await delayed.continue();
  await finished;
  await expectWeek(latest);
  await expect(alert).toHaveCount(0);
  await button('Poprzedni tydzień').click();
  await expectWeek(next);
});

for (const weekly of [false, true]) {
  test(`${weekly ? 'weekly series' : 'single block'} keeps the draft after failure and saves only once on double tap`, async ({
    page,
    request,
    salon,
  }) => {
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    await button('Następny dzień').click();
    await button('+ Zablokuj czas').click();
    await button('Od: 15 minut później').click();
    await button('Do: 15 minut wcześniej').click();
    if (weekly) {
      await button('Powtarzaj co tydzień').click();
      for (let i = 0; i < 5; i++) await button('Tydzień mniej').click();
    }
    const save = button('Zablokuj');
    const reason = page.getByRole('textbox', { name: 'Powód (np. przerwa)' });
    const note = 'Przerwa na szkolenie';
    await reason.fill(note);
    const path = `${salon.path}/time-blocks${weekly ? '/series' : ''}`;
    const url = `**${path}`;
    let posts = 0;
    page.on('request', (req) => {
      if (new URL(req.url()).pathname === path && req.method() === 'POST') posts++;
    });
    // Two clicks in the same turn also exercise the guard before React updates the button.
    const doubleTap = () =>
      save.evaluate((el: HTMLElement) => {
        el.click();
        el.click();
      });
    const failure = await holdNext(page, url);
    await doubleTap();
    const first = await failure.pending;
    await expect(save).toBeDisabled();
    await first.abort();
    await expect(page.getByRole('alert')).toContainText('Brak połączenia');
    await expect(save).toBeEnabled();
    await expect(reason).toHaveValue(note);
    await expect(page.getByLabel('Od 12:15')).toBeVisible();
    await expect(page.getByLabel('Do 12:45')).toBeVisible();
    if (weekly) await expect(page.getByText('tygodnie: 3')).toBeVisible();
    expect(posts).toBe(1);

    await page.route(
      url,
      (route) =>
        route.fulfill({
          status: weekly ? 400 : 409,
          json: {
            error: weekly
              ? {
                  code: 'VALIDATION_ERROR',
                  details: [{ path: 'reason', message: 'Invalid reason' }],
                }
              : { code: 'APPOINTMENTS_IN_THE_WAY' },
          },
        }),
      { times: 1 },
    );
    await save.click();
    if (weekly) {
      await expect(reason).toHaveAccessibleDescription(/Coś poszło nie tak/);
      await reason.fill(note + ' kadry');
    } else {
      await expect(
        page.getByRole('group', { name: 'Do', exact: true }),
      ).toHaveAccessibleDescription(/W tym czasie są już wizyty/);
      await button('Do: 15 minut później').click();
    }
    await expect(page.getByRole('alert')).toHaveCount(0);
    const success = await holdNext(page, url);
    await doubleTap();
    const last = await success.pending;
    await expect(save).toBeDisabled();
    await last.continue();
    await expect(
      page.getByText(
        weekly
          ? 'Zablokowano 3 razy, co tydzień.'
          : 'Czas zablokowany — klienci nie zapiszą się w tych godzinach.',
      ),
    ).toBeVisible();
    expect(posts).toBe(3);
    const date = addDays(salon.today, 1);
    const blocks = await json<{ date: string; seriesId: string | null }[]>(
      await request.get(`${salon.path}/time-blocks?from=${date}&to=${addDays(date, 21)}`, {
        headers: salon.headers,
      }),
    );
    expect(blocks.map((block) => block.date)).toEqual(
      weekly ? [date, addDays(date, 7), addDays(date, 14)] : [date],
    );
    expect(new Set(blocks.map((block) => block.seriesId)).size).toBe(1);
    if (weekly) expect(blocks[0]!.seriesId).toBeTruthy();
    else expect(blocks[0]!.seriesId).toBeNull();
  });
}
