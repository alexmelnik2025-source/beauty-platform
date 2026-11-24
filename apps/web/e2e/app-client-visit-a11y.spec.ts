import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';
import { DICTIONARIES, fill } from '../../mobile-client/src/i18n';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const staffName = 'Katarzyna Aleksandra Wiśniewska-Kowalczyk';
const serviceName = 'Strzyżenie z konsultacją, pielęgnacją i modelowaniem bardzo długich włosów';
const addressLine = 'Aleja Komisji Edukacji Narodowej 144, pawilon usługowy na pierwszym piętrze';
const dayMs = 86_400_000;

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.url()} → ${response.status()} ${await response.text()}`).toBe(
    true,
  );
  return (response.status() === 204 ? undefined : await response.json()) as T;
}

async function createSalon(api: APIRequestContext, name: string, email: string) {
  const password = 'e2e-password-123';
  const address = freshAddress();
  await json(
    await api.post('/v1/auth/register', {
      headers: address,
      data: { email, password, name: 'Aleksander Nowak' },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)![1]!;
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: address,
      data: { email, password, clientType: 'mobile' },
    }),
  );
  const headers = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers, data: { name } }),
  );
  const salons = `/v1/organizations/${org.id}/locations`;
  const location = await json<{ id: string; slug: string; version: number }>(
    await api.post(salons, {
      headers,
      data: {
        name,
        addressLine,
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
        bookingTerms: 'Regulamin rezerwacji wizyty w salonie.',
        privacyPolicy: 'Dane służą do obsługi wizyty w salonie.',
      },
    }),
  );
  return { headers, base: `${salons}/${location.id}`, location };
}

async function seedVisits(
  api: APIRequestContext,
  salon: Awaited<ReturnType<typeof createSalon>>,
  email: string,
) {
  const { base, headers, location } = salon;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers,
      data: { name: serviceName, durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  const staff = await json<{ id: string }>(
    await api.post(`${base}/staff`, {
      headers,
      data: { displayName: staffName, serviceIds: [service.id] },
    }),
  );
  // Weekdays have one slot. Weekends remain available for the waitlist.
  await json(
    await api.put(`${base}/staff/${staff.id}/working-hours`, {
      headers,
      data: {
        days: [1, 2, 3, 4, 5].map((weekday) => ({
          weekday,
          intervals: [{ start: '10:00', end: '10:45' }],
        })),
      },
    }),
  );
  await json(
    await api.put(`${base}/review-settings`, {
      headers,
      data: { version: 0, enabled: true, requestHours: 2 },
    }),
  );
  const selection = { serviceId: service.id, staffId: staff.id };
  const dayAhead = (days: number) => new Date(Date.now() + days * dayMs).toISOString().slice(0, 10);
  const { slots } = await json<{ slots: { start: string }[] }>(
    await api.get(`/v1/public/locations/${location.slug}/availability`, {
      params: { ...selection, from: dayAhead(3), to: dayAhead(10) },
    }),
  );
  expect(slots.length).toBeGreaterThan(0);
  const customer = { name: 'Anna Nowak', email, phone: '+48600111023' };
  await json(
    await api.post(`${base}/appointments`, {
      headers,
      data: { ...selection, start: slots[0]!.start, customer },
    }),
  );
  const earlier = new Date(Date.now() - 2 * 3_600_000);
  earlier.setUTCMinutes(0, 0, 0);
  await json(
    await api.post(`${base}/appointments`, {
      headers,
      data: { ...selection, start: earlier.toISOString(), customer, alreadyHappened: true },
    }),
  );
}

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true });

let app: Awaited<ReturnType<typeof serveApp>>;
let salon: Awaited<ReturnType<typeof createSalon>>;
let session: string;

test.beforeAll(async ({ request }) => {
  const run = Date.now().toString(36);
  const email = `aq-client-${run}@example.com`;
  salon = await createSalon(request, `Studio AQ ${run}`, `aq-owner-${run}@example.com`);
  await seedVisits(request, salon, email);
  const headers = freshAddress();
  await json(
    await request.post('/v1/client/auth/code', { headers, data: { email, locale: 'pl' } }),
  );
  const mail = await waitForEmail(email, /Kod logowania/);
  const { token } = await json<{ token: string }>(
    await request.post('/v1/client/auth/verify', {
      headers,
      data: { email, code: /\b(\d{6})\b/.exec(mail.text)![1], clientType: 'mobile' },
    }),
  );
  session = token;
  app = await serveApp('mobile-client');
});

test.afterAll(async ({ request }) => {
  app?.server.close();
  if (salon) {
    await expect(
      await request.patch(salon.base, {
        headers: salon.headers,
        data: { version: salon.location.version, onlineBookingEnabled: false },
      }),
    ).toBeOK();
  }
});

// RN Web emits pixel sizes. Scale its text rules once, including text rendered after navigation.
async function enlargeText(page: Page) {
  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const property of ['font-size', 'line-height']) {
          const size = rule.style.getPropertyValue(property);
          if (size.endsWith('px')) rule.style.setProperty(property, parseFloat(size) * 1.3 + 'px');
        }
      }
    }
  });
}

async function expectFits(element: Locator) {
  await element.scrollIntoViewIfNeeded();
  await expect(element).toBeInViewport({ ratio: 1 });
  const clipped = await element.evaluate((el) => {
    const range = document.createRange();
    const box = el.getBoundingClientRect();
    const nodes = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const clippedWords: string[] = [];
    while (nodes.nextNode()) {
      const node = nodes.currentNode;
      // RN Web preserves trailing spaces at a soft wrap. Measure the visible words.
      for (const word of (node.textContent ?? '').matchAll(/\S+/g)) {
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        if (
          Array.from(range.getClientRects()).some(
            (line) =>
              line.left < box.left - 1 ||
              line.right > box.right + 1 ||
              line.top < box.top - 1 ||
              line.bottom > box.bottom + 1,
          )
        )
          clippedWords.push(word[0]);
      }
    }
    return clippedWords;
  });
  expect(clipped).toEqual([]);
}

async function expectTarget(element: Locator) {
  await expectFits(element);
  const box = await element.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

for (const locale of ['pl', 'en', 'uk', 'ru'] as const) {
  test(`visit, review and automatic waitlist at 320 px and 130% text (${locale})`, async ({
    page,
    request,
  }) => {
    const t = DICTIONARIES[locale];
    await expect(
      await request.patch('/v1/client/me', {
        headers: { Authorization: `Bearer ${session}` },
        data: { locale },
      }),
    ).toBeOK();
    await page.addInitScript(
      (token) => localStorage.setItem('beauty.client.session', token),
      session,
    );
    await page.goto(app.url);
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const row = page.getByRole('button', { name: new RegExp(serviceName) });
    await row.click();
    const heading = page.getByRole('heading', { name: serviceName });
    await expect(heading).toBeVisible();
    const originalSize = await heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    await enlargeText(page);
    await expect(heading).toHaveCSS('font-size', (originalSize * 1.3).toFixed(1) + 'px');
    expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(320);
    await expectFits(heading);
    await expectFits(page.getByText(`${addressLine}, Warszawa`, { exact: true }));
    await expectFits(page.getByText(staffName, { exact: true }));
    await expectTarget(button(t.visit.move));
    await expectTarget(button(t.visit.cancel));

    await button(t.visit.move).click();
    await button('10:00').click();
    const move = page.getByRole('alertdialog', { name: t.visit.move });
    await expectTarget(move.getByRole('button', { name: t.visit.moveYes, exact: true }));
    await move.getByRole('button', { name: t.visit.moveNo, exact: true }).click();
    await button(t.visit.moveClose).click();
    await button(t.visit.cancel).click();
    const cancel = page.getByRole('alertdialog', { name: t.visit.cancel });
    await expectTarget(cancel.getByRole('button', { name: t.visit.cancelYes, exact: true }));
    await cancel.getByRole('button', { name: t.visit.cancelNo, exact: true }).click();

    await button(t.visit.back).click();
    await page.getByRole('tab', { name: t.visits.past, exact: true }).click();
    await row.click();
    const stars = page.getByRole('radiogroup', { name: t.review.rating });
    await button(t.review.send).click();
    await expect(stars).toHaveAttribute('aria-invalid', 'true');
    for (const n of [1, 2, 3, 4, 5]) {
      const star = stars.getByRole('radio', {
        name: fill(t.review.outOf, { n: String(n) }),
        exact: true,
      });
      await expectTarget(star);
      await star.tap();
      await expect(star).toBeChecked();
      await expect(stars.getByRole('radio', { checked: true })).toHaveCount(1);
    }

    await button(t.visit.bookAgain).click();
    await button(t.waitlist.open).click();
    const auto = page.getByRole('switch', { name: t.waitlist.autoBook, exact: true });
    await expectFits(page.getByText(t.waitlist.autoBook, { exact: true }));
    await expectTarget(auto);
    await expect(auto).not.toBeChecked();
    await auto.tap();
    await expect(auto).toBeChecked();
    await expect(page.getByRole('textbox', { name: t.book.phone, exact: true })).toBeVisible();
  });
}
