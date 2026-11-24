import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const staffName = 'Katarzyna Aleksandra Wiśniewska-Kowalczyk';
const serviceName = 'Strzyżenie męskie';
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
        addressLine: 'ul. Krótka 12',
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

interface Slot {
  date: string;
  time: string;
  start: string;
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
  // One slot per working day; booking another customer's slot fills that entire day.
  await json(
    await api.put(`${base}/staff/${staff.id}/working-hours`, {
      headers,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
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
  const { slots } = await json<{ slots: Slot[] }>(
    await api.get(`/v1/public/locations/${location.slug}/availability`, {
      params: { ...selection, from: dayAhead(3), to: dayAhead(10) },
    }),
  );
  expect(slots.length).toBeGreaterThanOrEqual(3);
  const [original, target, full] = slots as [Slot, Slot, Slot, ...Slot[]];
  const customer = { name: 'Anna Nowak', email, phone: '+48600111023' };
  await json(
    await api.post(`${base}/appointments`, {
      headers,
      data: { ...selection, start: original.start, customer },
    }),
  );
  await json(
    await api.post(`${base}/appointments`, {
      headers,
      data: {
        ...selection,
        start: full.start,
        customer: { name: 'Jan Nowak', phone: '+48600111024' },
      },
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
  return { original, target, full, selection };
}

function dayLabel(slot: Slot) {
  return new Intl.DateTimeFormat('pl-PL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(slot.date));
}

test.use({
  viewport: { width: 320, height: 844 },
  isMobile: true,
  locale: 'pl-PL',
  timezoneId: 'Europe/Warsaw',
});

test('client reviews a completed visit, moves and cancels an upcoming visit and joins the automatic waitlist', async ({
  page,
  request,
}) => {
  const run = Date.now().toString(36);
  const name = `Studio Wizyt ${run}`;
  const email = `visit-review-client-${run}@example.com`;
  const app = await serveApp('mobile-client');
  const salon = await createSalon(request, name, `visit-review-owner-${run}@example.com`);
  try {
    const { original, target, full, selection } = await seedVisits(request, salon, email);
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const visitRow = page.getByRole('button', { name: new RegExp(`${serviceName}, ${name}$`) });
    await page.setExtraHTTPHeaders(freshAddress());
    await page.goto(app.url);
    expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(320);
    await page.getByLabel('E-mail', { exact: true }).fill(email);
    await button('Wyślij kod').click();
    const mail = await waitForEmail(email, /Kod logowania/);
    await page.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await button('Zaloguj się').click();

    await test.step('Review a completed visit and correct an empty submission', async () => {
      await page.getByRole('tab', { name: 'Historia' }).click();
      await expect(visitRow).toContainText('Odbyła się');
      await visitRow.click();
      const review = page.getByRole('region', { name: 'Twoja opinia' });
      const send = review.getByRole('button', { name: 'Wyślij opinię' });
      await send.click();
      const error = review.getByRole('alert');
      await expect(error).toHaveText('! Wybierz ocenę od 1 do 5.');
      const stars = review.getByRole('radiogroup', { name: 'Ocena' });
      await expect(stars).toHaveAttribute('aria-invalid', 'true');
      const four = stars.getByRole('radio', { name: '4 z 5' });
      await four.click();
      await expect(four).toBeChecked();
      await expect(stars).toHaveAttribute('aria-invalid', 'false');
      await expect(error).toBeHidden();
      const words = 'Dokładne strzyżenie, dziękuję!';
      await review.getByLabel('Kilka słów (opcjonalnie)').fill(words);
      await send.click();
      await expect(review.getByRole('status')).toHaveText('Dziękujemy za opinię!');
      await button('‹ Wróć').click();
      await visitRow.click();
      await expect(review.getByLabel('4 z 5')).toBeVisible();
      await expect(review.getByText(words)).toBeVisible();
      await button('‹ Wróć').click();
    });

    await test.step('Move the upcoming visit, then confirm its cancellation', async () => {
      await page.getByRole('tab', { name: 'Nadchodzące' }).click();
      await expect(visitRow).toContainText('Potwierdzona');
      await visitRow.click();
      await expect(page.getByRole('heading', { name: serviceName })).toBeVisible();
      await expect(page.getByText(name, { exact: true })).toBeVisible();
      await expect(page.getByText(`${dayLabel(original)}, godz. ${original.time}`)).toBeVisible();
      await expect(page.getByText(staffName, { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.getByText(/90,00\s*zł/)).toBeVisible();
      await button('Zmień termin').click();
      await button(dayLabel(target)).click();
      await button(target.time).click();
      const move = page.getByRole('alertdialog', { name: 'Zmień termin' });
      await expect(move).toContainText(`${dayLabel(target)}, godz. ${target.time}`);
      await move.getByRole('button', { name: 'Tak, przenieś' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Termin zmieniony.' })).toBeVisible();
      await expect(
        page.getByText(`${dayLabel(target)}, godz. ${target.time}`, { exact: true }),
      ).toBeVisible();
      await button('Odwołaj wizytę').click();
      const cancel = page.getByRole('alertdialog', { name: 'Odwołaj wizytę' });
      await expect(cancel).toContainText(`${dayLabel(target)}, godz. ${target.time}`);
      await cancel.getByRole('button', { name: 'Nie', exact: true }).click();
      await expect(cancel).toBeHidden();
      await button('Odwołaj wizytę').click();
      await cancel.getByRole('button', { name: 'Tak, odwołaj' }).click();
      await expect(page.getByText('Odwołana', { exact: true })).toBeVisible();
      await expect(button('Zmień termin')).toBeHidden();
    });

    await test.step('Join the waitlist for a full day with automatic booking', async () => {
      await button('Umów ponownie').click();
      await button('Nie ma dogodnego dnia? Powiadom mnie, gdy zwolni się termin').click();
      await page.getByLabel('Imię i nazwisko', { exact: true }).fill('Anna Nowak');
      const auto = page.getByRole('switch', {
        name: 'Zapisz mnie automatycznie, gdy zwolni się termin',
      });
      await expect(auto).not.toBeChecked();
      await auto.check();
      const join = button(`Czekam na termin: ${dayLabel(full)}`);
      await join.click();
      const phone = page.getByLabel('Telefon', { exact: true });
      await expect(phone).toHaveAttribute('aria-invalid', 'true');
      await phone.fill('600 111 023');
      await join.click();
      const joined = page.getByRole('status').filter({ hasText: 'Zapisano na listę oczekujących' });
      const confirmation = `Zapisano na listę oczekujących: ${dayLabel(full)}. Gdy zwolni się termin, zarezerwujemy go automatycznie.`;
      await expect(joined).toHaveText(confirmation);
      // Returning to the same day must report the saved preference even when the switch is off.
      await page.goto(
        `${app.url}/pl/b/${salon.location.slug}?service=${selection.serviceId}&staff=${selection.staffId}`,
      );
      await button('Nie ma dogodnego dnia? Powiadom mnie, gdy zwolni się termin').click();
      await page.getByLabel('Imię i nazwisko', { exact: true }).fill('Anna Nowak');
      await expect(auto).not.toBeChecked();
      await join.click();
      await expect(joined).toHaveText(confirmation);
      const list = await json<{ items: unknown[] }>(
        await request.get(`${salon.base}/waitlist`, {
          headers: salon.headers,
          params: { from: full.date },
        }),
      );
      expect(list.items).toContainEqual(
        expect.objectContaining({ date: full.date, email, phone: '+48600111023', autoBook: true }),
      );
    });
  } finally {
    app.server.close();
    await json(
      await request.patch(salon.base, {
        headers: salon.headers,
        data: { version: salon.location.version, onlineBookingEnabled: false },
      }),
    );
  }
});
