import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => {
  app?.server.close();
});

async function createSalon(api: APIRequestContext, name: string, email: string) {
  const password = randomUUID();
  await expect(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { name: 'Ola Nowak', email, password },
    }),
  ).toBeOK();
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)![1]!;
  await expect(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token) } }),
  ).toBeOK();
  const login = await api.post('/v1/auth/login', {
    headers: freshAddress(),
    data: { email, password, clientType: 'mobile' },
  });
  await expect(login).toBeOK();
  const headers = { Authorization: `Bearer ${(await login.json()).accessToken}` };
  const org = await api.post('/v1/organizations', { headers, data: { name } });
  await expect(org).toBeOK();
  const locations = `/v1/organizations/${(await org.json()).id}/locations`;
  const created = await api.post(locations, {
    headers,
    data: {
      name,
      addressLine: 'ul. Prosta 5',
      city: 'Warszawa',
      postalCode: '00-001',
      onlineBookingEnabled: true,
      bookingTerms: 'Regulamin rezerwacji wizyty.',
      privacyPolicy: 'Administratorem danych jest salon.',
      askDrink: true,
      drinks: ['tea'],
    },
  });
  await expect(created).toBeOK();
  const location = await created.json();
  return {
    base: `${locations}/${location.id}`,
    slug: location.slug,
    version: location.version,
    headers,
  };
}

// A hidden overflow on a card can clip a name without widening the document.
async function expectNameFits(label: Locator) {
  await expect(label).toBeVisible();
  const fits = await label.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const box = element.getBoundingClientRect();
    return [...range.getClientRects()].every(
      (line) =>
        line.left >= Math.max(0, box.left) - 1 &&
        line.right <= Math.min(320, box.right) + 1 &&
        line.bottom <= box.bottom + 1,
    );
  });
  expect(fits, await label.innerText()).toBe(true);
}

test('an empty shop shows its Polish empty state before searching', async ({ page }) => {
  await page.route('**/v1/public/shop/products?*', (route) =>
    route.fulfill({
      json: { products: [], total: 0, page: 1, pageSize: 20 },
    }),
  );
  await page.goto(app.url);
  await page.getByRole('button', { name: /Sklep — kosmetyki z salonów/ }).click();
  await expect(page.getByRole('heading', { name: 'Sklep' })).toBeVisible();
  await expect(page.getByLabel('Szukaj produktu lub marki')).toHaveValue('');
  await expect(page.getByText('Salony nie dodały jeszcze produktów.')).toBeVisible();
});

test('a client books with wishes and photos, then reserves a shop product for that visit', async ({
  page,
  request,
}) => {
  const run = randomUUID().slice(0, 8);
  const email = `shop-wishes-${run}@example.com`;
  const salonName = `Pracownia Pielęgnacji Włosów i Stylizacji ${run}`;
  const product = `Maska IntensywnieRegenerującaDoWłosówWysokoporowatych ${run}`;
  const salon = await createSalon(request, salonName, `owner-${email}`);
  const { headers, base } = salon;
  try {
    const service = await request.post(`${base}/services`, {
      headers,
      data: {
        name: 'Pielęgnacja włosów',
        durationMinutes: 30,
        priceGrosze: 8000,
        wishPhotos: true,
      },
    });
    await expect(service).toBeOK();
    const serviceId = (await service.json()).id;
    const staff = await request.post(`${base}/staff`, {
      headers,
      data: { displayName: 'Ola', serviceIds: [serviceId] },
    });
    await expect(staff).toBeOK();
    await expect(
      await request.put(`${base}/staff/${(await staff.json()).id}/working-hours`, {
        headers,
        data: {
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            intervals: [{ start: '09:00', end: '18:00' }],
          })),
        },
      }),
    ).toBeOK();
    const catalog = await request.post(`${base}/shop/catalog`, {
      headers,
      data: { name: product, category: 'hair_care' },
    });
    await expect(catalog).toBeOK();
    await expect(
      await request.post(`${base}/products`, {
        headers,
        data: {
          name: product,
          catalogProductId: (await catalog.json()).id,
          inSalonShop: true,
          inMarketplace: true,
          priceGrosze: 4900,
          stockQuantity: 5,
        },
      }),
    ).toBeOK();
    await page.setExtraHTTPHeaders(freshAddress());
    await page.goto(`${app.url}/pl/b/${salon.slug}?service=${serviceId}`);
    await page
      .getByRole('button', { name: /^\d{2}:\d{2}$/ })
      .first()
      .click();
    await page.getByLabel('Imię i nazwisko').fill('Jan Kowalski');
    await page.getByLabel('Telefon', { exact: true }).fill('600 300 200');
    await page.getByRole('textbox', { name: 'E-mail', exact: true }).fill(email);
    await page.getByRole('checkbox', { name: /Akceptuję regulamin/ }).click();
    await page.getByRole('button', { name: 'Wyślij kod' }).click();
    await page.getByRole('button', { name: '+ Dodaj życzenie' }).click();

    const mood = page.getByRole('button', { name: /Wolę ciszę/ });
    const tea = page.getByRole('button', { name: /Herbata/ });
    const note = page.getByLabel('Coś, o czym specjalista powinien wiedzieć?');
    await mood.click();
    await tea.click();
    await note.fill('Wrażliwa skóra głowy.');

    // The web gallery can return more files than the phone picker allows.
    const colors = ['red', 'blue', 'green', 'yellow'];
    const images = await page.evaluate(
      (colors) =>
        colors.map((color) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 8;
          const brush = canvas.getContext('2d')!;
          brush.fillStyle = color;
          brush.fillRect(0, 0, 8, 8);
          return canvas.toDataURL('image/png').split(',')[1]!;
        }),
      colors,
    );
    const addPhoto = page.getByRole('button', { name: '＋ Dodaj zdjęcie' });
    const chooser = page.waitForEvent('filechooser');
    await addPhoto.click();
    await (
      await chooser
    ).setFiles(
      images.map((data, i) => ({
        name: `${colors[i]}.png`,
        mimeType: 'image/png',
        buffer: Buffer.from(data, 'base64'),
      })),
    );
    const remove = page.getByRole('button', { name: /^Usuń: Twoje zdjęcie / });
    await expect(remove).toHaveCount(3);
    await expect(addPhoto).toHaveCount(0);
    const photoPaths = () =>
      page
        .locator('img[alt^="Twoje zdjęcie"]')
        .evaluateAll((images) =>
          images.map((img) => new URL((img as HTMLImageElement).src).pathname),
        );
    const paths = await photoPaths();
    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(3);
    const remaining = [paths[0], paths[2]];
    await page.getByRole('button', { name: 'Usuń: Twoje zdjęcie 2' }).click();
    await expect(remove).toHaveCount(2);
    await expect(addPhoto).toBeEnabled();
    expect(await photoPaths()).toEqual(remaining);

    const code = await waitForEmail(email, /Kod potwierdzenia/);
    await page.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await page.getByRole('button', { name: 'Potwierdź wizytę' }).click();
    await expect(page.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
    await page.getByRole('button', { name: 'Zaloguj się do „Moich wizyt”' }).click();
    await page.getByRole('button', { name: 'Wyślij kod' }).click();
    const signIn = await waitForEmail(email, /Kod logowania do Twoich wizyt/);
    await page.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(signIn.text)![1]!);
    await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
    await page.getByRole('button', { name: /Sklep — kosmetyki z salonów/ }).click();
    await page.getByLabel('Szukaj produktu lub marki').fill(run);
    const item = page.getByRole('button', { name: new RegExp(product) });
    await expect(item).toContainText(/od 49,00\s*zł/);
    await expectNameFits(item.getByText(product, { exact: true }));
    await item.click();
    await expectNameFits(page.getByRole('heading', { name: product }));
    await expectNameFits(page.getByText(salonName, { exact: true }).filter({ visible: true }));
    const reserve = page.getByRole('button', { name: /^Odbiorę przy wizycie ·/ });
    await reserve.click();
    await expect(page.getByRole('alert')).toContainText('Odłożone na wizytę');
    await expect(reserve).toHaveCount(0);

    await page.getByRole('button', { name: '‹ Sklep', exact: true }).click();
    await page.getByRole('button', { name: '‹ Wróć', exact: true }).click();
    await page.getByRole('button', { name: /Pielęgnacja włosów, Pracownia/ }).click();
    const pickup = page.getByRole('region', { name: 'Produkty do odbioru' });
    await expectNameFits(pickup.getByText(product, { exact: true }));
    await expect(pickup).toContainText(/Razem za produkty: 49,00\s*zł/);
    await expect(mood).toHaveAttribute('aria-pressed', 'true');
    await expect(tea).toHaveAttribute('aria-pressed', 'true');
    await expect(note).toHaveValue('Wrażliwa skóra głowy.');
    await expect(remove).toHaveCount(2);
    expect(await photoPaths()).toEqual(remaining);
  } finally {
    await expect(
      await request.patch(base, {
        headers,
        data: { version: salon.version, onlineBookingEnabled: false },
      }),
    ).toBeOK();
  }
});
