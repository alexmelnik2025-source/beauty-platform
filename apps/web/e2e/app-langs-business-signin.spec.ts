import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DICTIONARIES, fill, LANGUAGE_NAMES } from '../../mobile-business/src/i18n';
import { freshAddress } from './addresses';
import { listTo, textOf, waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const orgName = 'Pracownia Fryzjerska i Kosmetyczna';
const salonName = 'Studio Pielęgnacji Włosów i Stylizacji przy Parku Zdrojowym';
const city = 'Nowe Miasto nad Pilicą';
const languageCodes = { en: 'EN', uk: 'UA', ru: 'RU' } as const;

async function prepareSalons(
  api: APIRequestContext,
  email: string,
  headers: Record<string, string>,
) {
  const credentials = { email, password: randomUUID() };
  await expect(
    await api.post('/v1/auth/register', {
      headers,
      data: { ...credentials, name: 'Salon Owner' },
    }),
  ).toBeOK();
  const verification = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(verification.text)![1]!;
  await expect(
    await api.post('/v1/auth/verify-email', {
      headers,
      data: { token: decodeURIComponent(token) },
    }),
  ).toBeOK();
  const login = await api.post('/v1/auth/login', {
    headers,
    data: { ...credentials, clientType: 'mobile' },
  });
  await expect(login).toBeOK();
  const owner = { ...headers, Authorization: `Bearer ${(await login.json()).accessToken}` };
  const organization = await api.post('/v1/organizations', {
    headers: owner,
    data: { name: orgName },
  });
  await expect(organization).toBeOK();
  const locations = `/v1/organizations/${(await organization.json()).id}/locations`;
  for (const name of ['Studio Centrum', salonName]) {
    await expect(
      await api.post(locations, {
        headers: owner,
        data: { name, city, addressLine: 'Aleja Niepodległości 135', postalCode: '26-420' },
      }),
    ).toBeOK();
  }
}

async function loginMail(email: string, previousId?: string) {
  const newest = async () =>
    (await listTo(email)).find(
      (message) =>
        message.Subject === 'Kod logowania do aplikacji salonu' && message.ID !== previousId,
    );
  await expect.poll(newest).toBeDefined();
  const { ID } = (await newest())!;
  return { id: ID, code: /\b(\d{6})\b/.exec(await textOf(ID))![1]! };
}

async function enlargeText(page: Page) {
  const heading = page.getByRole('heading', { name: DICTIONARIES.pl.signIn.title });
  await expect(heading).toBeVisible();
  const size = () => heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const original = await size();
  await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
  expect(await size()).toBeCloseTo(original * 1.3, 1);
}

// Measure the printed words, including wrapped lines inside scrollable containers.
async function expectTextFits(scope: Locator) {
  const clipped = await scope.evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const failures: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const box = node.parentElement!.getBoundingClientRect();
      const range = document.createRange();
      for (const word of (node.textContent ?? '').matchAll(/\S+/gu)) {
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        if (
          [...range.getClientRects()].some(
            (line) =>
              line.left < Math.max(0, box.left) - 1 ||
              line.right > Math.min(320, box.right) + 1 ||
              line.top < box.top - 1 ||
              line.bottom > box.bottom + 1,
          )
        )
          failures.push(word[0]);
      }
    }
    return failures;
  });
  expect(clipped).toEqual([]);
}

test.use({ viewport: { width: 320, height: 568 }, isMobile: true, locale: 'pl-PL' });

for (const locale of ['en', 'uk', 'ru'] as const) {
  test(`business sign-in, invalid code, resend and salon choice at 320 px and 130% (${locale})`, async ({
    page,
    request,
  }) => {
    const email = `business.signin.${randomUUID()}@example.com`;
    const headers = freshAddress();
    await prepareSalons(request, email, headers);
    const app = await serveApp('mobile-business');
    const t = DICTIONARIES[locale];
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const screen = page.locator('#root');
    try {
      await page.setExtraHTTPHeaders(headers);
      await page.goto(app.url);
      await enlargeText(page);
      const picker = button(`${DICTIONARIES.pl.language}: ${LANGUAGE_NAMES.pl}`);
      await expect(picker).toHaveText('PL ▾');
      const closedWidth = (await picker.boundingBox())!.width;
      await picker.click();
      const options = page.getByRole('group', { name: DICTIONARIES.pl.language, exact: true });
      await expect(options.getByRole('button', { pressed: true })).toHaveText('PL · Polski');
      await expect(
        options.getByRole('button', { name: 'UA · Українська', exact: true }),
      ).toBeVisible();
      await expect(picker).toHaveAttribute('aria-expanded', 'true');
      expect((await picker.boundingBox())!.width).toBeLessThanOrEqual(closedWidth + 4);
      await expectTextFits(screen);
      await options
        .getByRole('button', {
          name: `${languageCodes[locale]} · ${LANGUAGE_NAMES[locale]}`,
          exact: true,
        })
        .click();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const selected = button(`${t.language}: ${LANGUAGE_NAMES[locale]}`);
      await expect(selected).toHaveText(`${languageCodes[locale]} ▾`);
      await expect(selected).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('heading', { name: t.signIn.title, exact: true })).toBeVisible();
      await expectTextFits(screen);
      await page.getByRole('textbox', { name: t.signIn.contact, exact: true }).fill(email);
      await button(t.signIn.sendCode).click();
      const code = page.getByRole('textbox', { name: t.signIn.code, exact: true });
      const sent = fill(t.signIn.sentEmail, { to: email });
      await expect(code).toHaveAccessibleDescription(sent);
      const first = await loginMail(email);
      await code.fill(first.code === '000000' ? '000001' : '000000');
      await button(t.signIn.confirm).click();
      const alert = page.getByRole('alert');
      await expect(alert).toHaveText(`! ${t.signIn.badCode}`);
      await expect(code).toHaveAttribute('aria-invalid', 'true');
      await expect(code).toHaveAccessibleDescription(`! ${t.signIn.badCode}`);
      const inputBox = (await code.boundingBox())!;
      const errorBox = (await alert.boundingBox())!;
      const gap = errorBox.y - inputBox.y - inputBox.height;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(8);
      await expectTextFits(screen);
      await button(t.signIn.sendCode).click();
      const second = await loginMail(email, first.id);
      await expect(alert).toHaveCount(0);
      await expect(code).toHaveValue('');
      await expect(code).toHaveAccessibleDescription(sent);
      await code.fill(second.code);
      await button(t.signIn.confirm).click();
      await expect(page.getByRole('heading', { name: t.salons.title })).toBeVisible();
      await expect(button('Studio Centrum')).toBeVisible();
      const choice = button(salonName);
      const details = `${orgName} · ${city} · ${t.salons.role.owner}`;
      await expect(choice.getByText(details, { exact: true })).toBeVisible();
      await expect(choice).toHaveAccessibleDescription(details);
      await expectTextFits(screen);
      await choice.click();
      await expect(
        page.getByRole('tab', { name: t.navigation.calendar, exact: true }),
      ).toBeVisible();
      await expect(page.getByText(salonName, { exact: true })).toBeVisible();
    } finally {
      app.server.close();
    }
  });
}
