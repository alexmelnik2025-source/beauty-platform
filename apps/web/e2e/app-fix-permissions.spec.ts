import { expect, test } from '@playwright/test';
import { en } from '../../mobile-business/src/locales/en';
import { serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 740 }, isMobile: true, locale: 'en-GB' });

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app.server.close());

test('a new permission category survives a failed save and a return to the team', async ({
  page,
}) => {
  const org = '/v1/organizations/org';
  const salon = {
    id: 'salon',
    name: 'Salon EA',
    city: 'Warszawa',
    timezone: 'Europe/Warsaw',
    currency: 'PLN',
  };
  const reads: Record<string, unknown> = {
    '/v1/auth/refresh': { accessToken: 'session', refreshToken: 'session' },
    '/v1/me': { user: { id: 'owner' }, organizations: [{ id: 'org', role: 'owner', name: 'EA' }] },
    [org + '/locations']: [salon],
    [org + '/locations/salon/staff']: [],
    [org + '/members']: [],
    [org + '/invitations']: [],
    [org + '/staff-categories']: [],
    [org + '/permissions']: {
      permissions: [{ key: 'viewClientContacts', default: false }],
      me: { role: 'owner', permissions: {} },
    },
  };
  const submissions: unknown[] = [];
  const draft = { name: 'Senior DR', permissions: { viewClientContacts: true } };
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === org + '/staff-categories' && route.request().method() === 'POST') {
      submissions.push(route.request().postDataJSON());
      if (submissions.length === 1) return route.abort('connectionreset');
      const category = { ...draft, id: 'senior', memberCount: 0, version: 1 };
      reads[path] = [category];
      return route.fulfill({ status: 201, json: category });
    }
    return path in reads
      ? route.fulfill({ json: reads[path] })
      : route.fulfill({ status: 404, json: {} });
  });
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'session'));
  await page.goto(app.url);
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const openPermissions = async () => {
    await button(en.navigation.more).click();
    await button(en.rights.open).click();
  };
  await page.getByRole('tab', { name: en.navigation.more, exact: true }).click();
  await button(en.team.open).click();
  await openPermissions();
  const heading = page.getByRole('heading', { name: en.rights.title, exact: true });
  const fontSize = () => heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const initialSize = await fontSize();
  await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
  expect(await fontSize()).toBeCloseTo(initialSize * 1.3, 1);

  await button(en.rights.addCategory).click();
  const name = page.getByRole('textbox', { name: en.rights.categoryName });
  const contacts = page.getByRole('checkbox', { name: en.rights.names.viewClientContacts });
  await name.fill(draft.name);
  await contacts.check();
  await button(en.rights.save).click();
  await expect(page.getByRole('alert')).toHaveText(en.error.network);

  await button(en.rights.back).click();
  await openPermissions();
  await expect(name).toHaveValue(draft.name);
  await expect(contacts).toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await button(en.rights.save).click();
  await expect(page.getByText(en.rights.categorySaved, { exact: true })).toBeVisible();
  expect(submissions).toEqual([draft, draft]);
  await button(en.rights.addCategory).click();
  await expect(name).toHaveValue('');
  await expect(contacts).not.toBeChecked();
});
