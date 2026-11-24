import { expect, test, type APIResponse, type Locator } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { openBusinessMenu, serveApp } from './mobile-app';

const longName = 'Aleksandra Konstantynopolitańczykowianeczka-Wojciechowska';
const secondName = 'Marek Nowak';

async function json<T>(response: APIResponse): Promise<T> {
  await expect(response).toBeOK();
  return response.json();
}

async function expectTouchTarget(control: Locator) {
  const box = await control.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
}

/** Expo web exports font sizes in px. Enlarge the actual text without scaling the viewport. */
async function checkLargeText(section: Locator) {
  const clipped = await section.evaluate((root) => {
    const sectionBounds = root.getBoundingClientRect();
    const labels = Array.from(root.querySelectorAll<HTMLElement>('*')).filter(
      (el) =>
        el.childElementCount === 0 && (el.textContent?.trim() || el instanceof HTMLInputElement),
    );
    const sizes = labels.map((el) => parseFloat(getComputedStyle(el).fontSize));
    labels.forEach((el, i) => {
      el.style.fontSize = sizes[i]! * 1.3 + 'px';
    });

    return labels
      .filter((el) => {
        const bounds = el.getBoundingClientRect();
        if (
          bounds.left < Math.max(0, sectionBounds.left) - 1 ||
          bounds.right > Math.min(document.documentElement.clientWidth, sectionBounds.right) + 1
        )
          return true;
        if (el instanceof HTMLInputElement) return el.scrollWidth > el.clientWidth + 1;
        const range = document.createRange();
        range.selectNodeContents(el);
        return Array.from(range.getClientRects()).some(
          (line) =>
            line.left < bounds.left - 1 ||
            line.right > bounds.right + 1 ||
            line.top < bounds.top - 1 ||
            line.bottom > bounds.bottom + 1,
        );
      })
      .map((el) => el.textContent || el.getAttribute('aria-label'));
  });
  expect(clipped).toEqual([]);
}

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

test('report commissions: empty state, staff shares and payout at 130% text size', async ({
  page,
  request,
}) => {
  const email = `commissions-${Date.now().toString(36)}@example.com`;
  const account = { email, password: 'e2e-password-123' };
  const address = freshAddress();
  await expect(
    await request.post('/v1/auth/register', {
      headers: address,
      data: { ...account, name: 'Właściciel' },
    }),
  ).toBeOK();
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)![1]!;
  await expect(
    await request.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token) } }),
  ).toBeOK();
  const session = await json<{ accessToken: string; refreshToken: string }>(
    await request.post('/v1/auth/login', {
      headers: address,
      data: { ...account, clientType: 'mobile' },
    }),
  );
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers, data: { name: 'Prowizje' } }),
  );
  const locations = `/v1/organizations/${org.id}/locations`;
  const salon = await json<{ id: string }>(
    await request.post(locations, {
      headers,
      data: { name: 'Salon Q', addressLine: 'Bema 91', city: 'Warszawa', postalCode: '01-233' },
    }),
  );
  const base = `${locations}/${salon.id}`;
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers,
      data: { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 10000 },
    }),
  );
  const start = new Date(Math.floor((Date.now() - 3_600_000) / 300_000) * 300_000).toISOString();
  for (const displayName of [longName, secondName]) {
    const staff = await json<{ id: string }>(
      await request.post(`${base}/staff`, {
        headers,
        data: { displayName, serviceIds: [service.id] },
      }),
    );
    const visit = await json<{ id: string; version: number }>(
      await request.post(`${base}/appointments`, {
        headers,
        data: {
          serviceId: service.id,
          staffId: staff.id,
          start,
          alreadyHappened: true,
          paid: true,
          customer: { name: 'Jan Kowalski', phone: '+48600321432' },
        },
      }),
    );
    if (displayName === secondName) {
      await expect(
        await request.put(`${base}/appointments/${visit.id}/tip`, {
          headers,
          data: { version: visit.version, tipGrosze: 725 },
        }),
      ).toBeOK();
    }
  }

  const app = await serveApp('mobile-business');
  try {
    await page.addInitScript(
      (refreshToken) => localStorage.setItem('beauty.business.refreshToken', refreshToken),
      session.refreshToken,
    );
    await page.goto(app.url);
    await openBusinessMenu(page, 'Raporty');
    await page.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
    const section = page.getByTestId('report-commissions');
    const open = section.getByRole('button', { name: 'Ustaw prowizje', expanded: false });
    await expect(section.getByRole('heading')).toHaveText('Prowizje: brak');
    await expect(section).toHaveText('Prowizje: brakUstaw prowizje');
    await expectTouchTarget(open);
    await open.click();

    for (const [name, percent] of [
      [longName, '12,5'],
      [secondName, '40'],
    ] as const) {
      const field = section.getByRole('textbox', { name: `Prowizja, % — ${name}`, exact: true });
      const save = section.getByRole('button', { name: `Zapisz prowizję — ${name}`, exact: true });
      await expectTouchTarget(field);
      await expectTouchTarget(save);
      await field.fill(percent);
      await save.click();
      const row = section.getByRole('group', { name: new RegExp(name) });
      await expect(row.getByText(name, { exact: true })).toBeVisible();
      if (name === longName) {
        await expect(section.getByTestId('report-payout')).toHaveText(
          'Razem do wypłaty (z napiwkami): 12,50 zł',
        );
      }
    }

    await expect(section.getByRole('heading')).toHaveText('Prowizje: 52,50 zł');
    await expect(section.getByRole('group', { name: new RegExp(longName) })).toHaveAccessibleName(
      `${longName}, 12,5% · 12,50 zł`,
    );
    await expect(section.getByRole('group', { name: /Marek Nowak/ })).toHaveAccessibleName(
      'Marek Nowak, 40% · 40,00 zł, + napiwki 7,25 zł = 47,25 zł',
    );
    await expect(section.getByTestId('report-payout')).toHaveText(
      'Razem do wypłaty (z napiwkami): 59,75 zł',
    );
    await checkLargeText(section);
    const close = section.getByRole('button', { name: 'Zwiń prowizje', expanded: true });
    await expectTouchTarget(close);
    await close.click();
    await expect(section.getByRole('textbox')).toHaveCount(0);
  } finally {
    app.server.close();
  }
});
