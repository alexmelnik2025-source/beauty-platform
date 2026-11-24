import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { listTo, textOf, waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task Q3 in the client app: a visit with a product put aside is cancelled; its card in "Moje
 * wizyty" shows "Przenieść produkty na nowy termin?" instead of "Umów ponownie" — one button books
 * the same specialist and the product comes along to the new visit (Q3-move-app,
 * Q3-move-app-booked).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `move-app-${run}@example.com`;
const CLIENT = `move-app-client-${run}@example.com`;
const PHONE = { width: 320, height: 844 };
const SALON = `Przenosiny Apka Studio Pielęgnacji Włosów na Woli w Warszawie ${run}`;
const PRODUCT = 'Pomada Reuzel różowa do stylizacji długich i kręconych włosów';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

async function expectTouchTarget(button: Locator) {
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
}

// The Expo web preview uses pixel font sizes. Enlarge its text while keeping the viewport at 320 px.
async function expectLargeTextToFit(section: Locator) {
  await expect(section).toBeVisible();
  const overflowing = await section.evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Node[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const sizes = new Map<HTMLElement, number>();
    for (const node of nodes) {
      const el = node.parentElement!;
      sizes.set(el, parseFloat(getComputedStyle(el).fontSize));
    }
    for (const [el, size] of sizes) el.style.fontSize = `${size * 1.3}px`;
    const bounds = root.getBoundingClientRect();
    return nodes
      .filter((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        return (
          rect.left < Math.max(0, bounds.left) - 1 ||
          rect.right > Math.min(innerWidth, bounds.right) + 1 ||
          rect.top < bounds.top - 1 ||
          rect.bottom > bounds.bottom + 1
        );
      })
      .map((node) => node.textContent);
  });
  expect(overflowing).toEqual([]);
}

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** The newest "Kod potwierdzenia" that came after `before` such emails. */
async function nextCode(before: number): Promise<string> {
  const until = Date.now() + 20_000;
  for (;;) {
    const codes = (await listTo(CLIENT)).filter((m) => /Kod potwierdzenia/.test(m.Subject));
    if (codes.length > before) return /\b(\d{6})\b/.exec(await textOf(codes[0]!.ID))![1]!;
    if (Date.now() > until) throw new Error('No new code');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const codeCount = async () =>
  (await listTo(CLIENT)).filter((m) => /Kod potwierdzenia/.test(m.Subject)).length;

async function owner(api: APIRequestContext) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Właściciel' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const auth = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: auth, data: { name: SALON } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: auth,
      data: {
        name: SALON,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${SALON}.`,
      },
    }),
  );
  return {
    auth,
    base: `/v1/organizations/${org.id}/locations/${location.id}`,
    slug: location.slug,
  };
}

test('"Przenieść produkty na nowy termin?" in the client app (task Q3)', async ({
  browser,
  request,
}) => {
  const salon = await owner(request);
  const pomade = await json<{ id: string }>(
    await request.post(`${salon.base}/products`, {
      headers: salon.auth,
      data: {
        name: PRODUCT,
        priceGrosze: 5900,
        stockQuantity: 5,
        inSalonShop: true,
      },
    }),
  );
  const cut = await json<{ id: string }>(
    await request.post(`${salon.base}/services`, {
      headers: salon.auth,
      data: { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 },
    }),
  );
  const ilya = await json<{ id: string }>(
    await request.post(`${salon.base}/staff`, {
      headers: salon.auth,
      data: { displayName: 'Ilya', serviceIds: [cut.id] },
    }),
  );
  await json(
    await request.put(`${salon.base}/staff/${ilya.id}/working-hours`, {
      headers: salon.auth,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '08:00', end: '20:00' }],
        })),
      },
    }),
  );

  // A visit two days ahead with the pomade put aside, then cancelled by the client.
  const ip = freshAddress();
  const from = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
  const free = await json<{ slots: { start: string }[] }>(
    await request.get(`/v1/public/locations/${salon.slug}/availability`, {
      params: { serviceId: cut.id, staffId: ilya.id, from, to },
    }),
  );
  const hold = await json<{ holdId: string; holdToken: string }>(
    await request.post(`/v1/public/locations/${salon.slug}/holds`, {
      headers: ip,
      data: { serviceId: cut.id, staffId: ilya.id, start: free.slots[0]!.start },
    }),
  );
  const before = await codeCount();
  await json(
    await request.post(`/v1/public/holds/${hold.holdId}/code`, {
      headers: ip,
      data: {
        holdToken: hold.holdToken,
        name: 'Anna Kowalska',
        phone: '+48600100205',
        email: CLIENT,
        locale: 'pl',
        acceptTerms: true,
      },
    }),
  );
  const first = await json<{ appointment: { id: string }; manageToken: string }>(
    await request.post(`/v1/public/holds/${hold.holdId}/confirm`, {
      headers: ip,
      data: { holdToken: hold.holdToken, code: await nextCode(before) },
    }),
  );
  await json(
    await request.post(`/v1/public/appointments/${first.manageToken}/products`, {
      headers: ip,
      data: { productId: pomade.id },
    }),
  );
  await json(
    await request.post(`/v1/public/appointments/${first.manageToken}/cancel`, {
      headers: ip,
      data: {},
    }),
  );

  const clientApp = await serveApp('mobile-client');
  try {
    const phone = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      extraHTTPHeaders: freshAddress(),
    });
    const app = await phone.newPage();
    await app.goto(clientApp.url);
    await app.getByRole('button', { name: 'Znajdź salon', exact: true }).click();
    await app.getByLabel('Czego szukasz? Usługa, salon, miasto lub ulica').fill(SALON);
    const salonCard = app.getByRole('article', { name: SALON });
    const status = salonCard.getByLabel(/^(Otwarte|Zamknięte)/);
    await expectLargeTextToFit(status);
    const openFilter = app.getByRole('button', { name: /^Otwarte teraz/ });
    await expectTouchTarget(openFilter);
    await salonCard.getByRole('button', { name: 'Zobacz salon' }).click();
    await app.getByRole('button', { name: /^O salonie/ }).click();
    const showQr = app.getByRole('button', { name: 'Pokaż kod QR' });
    await expectLargeTextToFit(showQr);
    await expectTouchTarget(showQr);
    await showQr.click();
    const qr = app.getByRole('img', { name: 'Kod QR salonu' });
    await expect(qr).toBeVisible();
    const qrBox = (await qr.boundingBox())!;
    expect(qrBox.width).toBeGreaterThan(150);
    expect(Math.abs(qrBox.width - qrBox.height)).toBeLessThan(1);
    expect(qrBox.width).toBeLessThanOrEqual(
      await qr.evaluate((el) => el.parentElement!.clientWidth),
    );
    await app.reload();
    await app.getByLabel('E-mail', { exact: true }).fill(CLIENT);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const signIn = await waitForEmail(CLIENT, /Kod logowania do Twoich wizyt/);
    await app.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(signIn.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await app.getByRole('tab', { name: 'Historia', exact: true }).click();
    const visit = app.getByRole('button', { name: /Strzyżenie, Przenosiny Apka/ });
    const productsUrl = `**/v1/client/appointments/${first.appointment.id}/products`;
    await app.route(productsUrl, (route) =>
      route.fulfill({ json: { reservations: [], currency: 'PLN' } }),
    );
    await visit.click();
    await expectLargeTextToFit(app.getByText('Produkty do odbioru: 0', { exact: true }));
    await expectTouchTarget(app.getByRole('button', { name: 'Umów ponownie' }));
    await expect(app.getByRole('button', { name: 'Wybierz nowy termin' })).toHaveCount(0);
    await app.getByRole('button', { name: '‹ Wróć' }).click();
    await app.unroute(productsUrl);
    await visit.click();
    const move = app.getByRole('region', { name: 'Przenieść produkty na nowy termin?' });
    await expect(move.getByText(PRODUCT)).toBeVisible();
    await expect(move.getByText(/59,00\s*zł/)).toBeVisible();
    await expectLargeTextToFit(move);
    const moveButton = move.getByRole('button', { name: 'Wybierz nowy termin' });
    await expectTouchTarget(moveButton);
    // One main button: "Umów ponownie" gives way to "Wybierz nowy termin".
    await expect(app.getByRole('button', { name: 'Umów ponownie' })).toHaveCount(0);
    await move.scrollIntoViewIfNeeded();
    await shot(app, 'Q3-move-app');

    await moveButton.click();
    await expect(app.getByRole('heading', { name: 'Wybierz termin' })).toBeVisible();
    await app
      .getByRole('button', { name: /^\d{2}:\d{2}$/ })
      .first()
      .click();
    await expect(app.getByRole('heading', { name: 'Twoje dane' })).toBeVisible();
    await app.getByRole('textbox', { name: 'Imię i nazwisko' }).fill('Anna Kowalska');
    await app.getByRole('textbox', { name: 'Telefon' }).fill('600 100 205');
    await app.getByRole('checkbox', { name: /Akceptuję regulamin rezerwacji/ }).click();
    await app.getByRole('button', { name: 'Potwierdź wizytę' }).click();
    await expect(app.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
    await expect(
      app.getByText('✓ Produkty czekają na Ciebie w salonie: 1. Zapłacisz przy odbiorze.'),
    ).toBeVisible();
    await shot(app, 'Q3-move-app-booked');
    await phone.close();
  } finally {
    clientApp.server.close();
  }
  // The salon sees the pomade waiting on the new visit.
  const visits = await json<{ id: string; status: string }[]>(
    await request.get(`${salon.base}/appointments`, {
      headers: salon.auth,
      params: { from: new Date().toISOString().slice(0, 10), to },
    }),
  );
  const fresh = visits.find((v) => v.id !== first.appointment.id && v.status === 'confirmed');
  const waiting = await json<{ reservations: { status: string }[] }>(
    await request.get(`${salon.base}/appointments/${fresh!.id}/reservations`, {
      headers: salon.auth,
    }),
  );
  expect(waiting.reservations.map((r) => r.status)).toEqual(['reserved']);
});
