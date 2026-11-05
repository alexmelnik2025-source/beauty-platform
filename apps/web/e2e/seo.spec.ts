import { expect, request as playwrightRequest, test, type APIResponse } from '@playwright/test';
import { waitForEmail } from './mailpit';

/**
 * Task 130: search engines. With indexing on (PUBLIC_INDEXING=1 in the e2e job) robots.txt
 * lets crawlers into the catalogue and the booking pages only, sitemap.xml lists the salon in
 * every language, and the salon's booking page has its own title, description, language
 * versions and schema.org data. The salon dashboard stays out of search. Screenshot 130.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `seo-owner-${run}@example.com`;
const NAME = `Seo Barber ${run}`;
// The salon's own text, with something that must not end the JSON-LD script tag.
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const DESCRIPTION = 'Strzyżemy od 2015 roku. </script><b>Kawa gratis</b>';

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function bookableSalon(baseURL: string): Promise<string> {
  // An address of its own: owner sign-ups are limited per address.
  const api = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.130' },
  });
  await json(
    await api.post('/v1/auth/register', {
      data: { email: OWNER, password: PASSWORD, name: 'Seo Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: owner, data: { name: NAME } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: NAME,
        addressLine: 'ul. Marszałkowska 10',
        city: 'Warszawa',
        postalCode: '00-590',
        phone: '+48221234567',
        description: DESCRIPTION,
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: '# Prywatność\n\nAdministratorem danych jest salon.',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000, bufferMinutes: 0 },
    }),
  );
  const staff = await json<{ id: string }>(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Marek', serviceIds: [service.id] },
    }),
  );
  await json(
    await api.put(`${base}/staff/${staff.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5].map((weekday) => ({
          weekday,
          intervals: [{ start: '09:00', end: '18:00' }],
        })),
      },
    }),
  );
  await api.dispose();
  return location.slug;
}

test('salon pages are ready for search engines, the dashboard is not indexed', async ({
  page,
  request,
  baseURL,
}) => {
  const slug = await bookableSalon(baseURL!);

  const robots = await request.get('/robots.txt');
  expect(robots.ok()).toBeTruthy();
  const robotsText = await robots.text();
  expect(robotsText).toContain('Allow: /*/b/');
  expect(robotsText).toContain('Disallow: /*/app');
  expect(robotsText).toMatch(/Sitemap: http:\/\/localhost:3000\/sitemap\.xml/);

  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.ok()).toBeTruthy();
  const sitemapText = await sitemap.text();
  expect(sitemapText).toContain(`http://localhost:3000/pl/b/${slug}`);
  expect(sitemapText).toContain(`http://localhost:3000/uk/b/${slug}`);
  expect(sitemapText).toContain('http://localhost:3000/en/salons');

  // What a crawler receives: the metadata is in <head> of the first HTML (no streaming).
  const html = await (
    await request.get(`/en/b/${slug}`, { headers: { 'user-agent': GOOGLEBOT } })
  ).text();
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
  expect(head).toContain(`<title>${NAME} — Warszawa · book online</title>`);
  expect(head).toMatch(/<meta name="robots" content="index, follow"\/>/);
  expect(head).toMatch(/<meta name="description" content="Strzyżemy od 2015 roku\./);
  expect(head).toContain(`<link rel="canonical" href="http://localhost:3000/en/b/${slug}"/>`);
  expect(head).toMatch(
    new RegExp(
      `<link rel="alternate" hreflang="pl-PL" href="http://localhost:3000/pl/b/${slug}"/>`,
      'i',
    ),
  );
  expect(head).toContain(`<meta property="og:title" content="${NAME} — Warszawa · book online"/>`);
  // No text of the salon can close the script tag: "<" is escaped inside it.
  const script = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  expect(script).toBeTruthy();
  expect(script).not.toContain('<');
  const ld = JSON.parse(script!) as {
    '@type': string;
    name: string;
    telephone: string;
    description: string;
    address: { streetAddress: string; postalCode: string };
    openingHoursSpecification: { dayOfWeek: string; opens: string; closes: string }[];
    makesOffer: { itemOffered: { name: string }; price: string; priceCurrency: string }[];
  };
  expect(ld['@type']).toBe('BeautySalon');
  expect(ld.name).toBe(NAME);
  expect(ld.telephone).toBe('+48221234567');
  expect(ld.description).toBe(DESCRIPTION);
  expect(ld.address).toMatchObject({ streetAddress: 'ul. Marszałkowska 10', postalCode: '00-590' });
  expect(ld.openingHoursSpecification).toHaveLength(5);
  expect(ld.openingHoursSpecification[0]).toMatchObject({
    dayOfWeek: 'https://schema.org/Monday',
    opens: '09:00',
    closes: '18:00',
  });
  expect(ld.makesOffer).toEqual([
    expect.objectContaining({
      itemOffered: expect.objectContaining({ name: 'Strzyżenie męskie' }),
      price: '90.00',
      priceCurrency: 'PLN',
    }),
  ]);

  // People see the same page as before, with the salon's name in the tab.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/en/b/${slug}`);
  await expect(page).toHaveTitle(`${NAME} — Warszawa · book online`);
  await expect(page.getByText('Strzyżenie męskie').first()).toBeVisible();
  await expect(page.locator('b', { hasText: 'Kawa gratis' })).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/130-salon-page-for-search.png' });

  // The catalogue has its own title in each language.
  const catalogue = await (
    await request.get('/pl/salons', { headers: { 'user-agent': GOOGLEBOT } })
  ).text();
  expect(catalogue).toContain('<title>Salony z rezerwacją online · GESTALT</title>');
  expect(catalogue).toMatch(/<meta name="robots" content="index, follow"\/>/);

  // The dashboard's sign-in and an unknown salon are never indexed.
  for (const path of ['/pl/login', '/pl/b/no-such-salon-130']) {
    const other = await (await request.get(path, { headers: { 'user-agent': GOOGLEBOT } })).text();
    expect(other, path).toMatch(/<meta name="robots" content="noindex/);
  }
});
