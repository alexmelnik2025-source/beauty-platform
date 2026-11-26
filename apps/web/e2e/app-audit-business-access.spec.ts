import { expect, test, type Page } from '@playwright/test';
import { DICTIONARIES, LANGUAGE_NAMES, LOCALES } from '../../mobile-business/src/i18n';
import {
  auditBase,
  expectAuditTextFits,
  installAuditSession,
  scaleAuditText,
} from './audit-business';
import { serveApp } from './mobile-app';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const title = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const tokens = { accessToken: 'audit-access', refreshToken: 'audit-refresh' };
const org = '**/v1/organizations/org';
let app: Awaited<ReturnType<typeof serveApp>>;

test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app.server.close());

function gate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

for (const locale of LOCALES) {
  const t = DICTIONARIES[locale];
  test.describe(locale, () => {
    test.use({ viewport: { width: 320, height: 740 }, isMobile: true, locale });

    test('code sign-in and an empty salon list survive a dropped connection', async ({ page }) => {
      const firstSend = gate();
      let sends = 0;
      let verifies = 0;
      await page.route('**/v1/auth/code', async (route) => {
        expect(route.request().postDataJSON()).toEqual({ email: 'salon@example.org', locale });
        if (++sends === 1) {
          await firstSend.pending;
          return route.abort();
        }
        return route.fulfill({ json: { channel: 'email' } });
      });
      await page.route('**/v1/auth/code/verify', (route) => {
        if (++verifies === 1) {
          return route.fulfill({ status: 403, json: { error: { code: 'NO_INVITATION' } } });
        }
        return route.fulfill({ json: tokens });
      });
      await page.route('**/v1/me', (route) => route.fulfill({ json: { organizations: [] } }));
      await page.goto(app.url);
      await scaleAuditText(page, title(page, t.signIn.title));
      const contact = page.getByRole('textbox', { name: t.signIn.contact, exact: true });
      const send = button(page, t.signIn.sendCode);
      await expect(send).toBeDisabled();
      await button(page, t.language + ': ' + LANGUAGE_NAMES[locale]).click();
      const ukrainian = button(page, 'UA · ' + LANGUAGE_NAMES.uk);
      await expectAuditTextFits(ukrainian);
      await button(
        page,
        (locale === 'uk' ? 'UA' : locale.toUpperCase()) + ' · ' + LANGUAGE_NAMES[locale],
      ).click();
      await contact.fill('salon@example.org');
      try {
        await send.dblclick();
        await expect(send).toBeDisabled();
        await expect.poll(() => sends).toBe(1);
      } finally {
        firstSend.release();
      }
      await expect(page.getByRole('alert')).toContainText(t.error.network);
      await expect(contact).toHaveValue('salon@example.org');
      await send.click();
      const code = page.getByRole('textbox', { name: t.signIn.code, exact: true });
      const confirm = button(page, t.signIn.confirm);
      await expect(confirm).toBeDisabled();
      await code.fill('001234');
      await confirm.click();
      await expectAuditTextFits(page.getByRole('alert'));
      await expect(code).toHaveAccessibleDescription('! ' + t.signIn.noInvitation);
      await expect(code).not.toHaveAttribute('aria-invalid', 'true');
      // A renewed invitation and a new code allow the person to continue.
      await send.click();
      await expect(code).toHaveValue('');
      await code.fill('005678');
      await confirm.dblclick();
      await expect(title(page, t.salons.title)).toBeVisible();
      await expectAuditTextFits(page.getByText(t.salons.none, { exact: true }));
      await expect(button(page, t.salons.create)).toBeEnabled();
      expect(verifies).toBe(2);
      await page.route('**/v1/auth/logout', (route) => route.abort());
      await button(page, t.signOut).dblclick();
      await expect(contact).toHaveValue('');
      expect(
        await page.evaluate(() => localStorage.getItem('beauty.business.refreshToken')),
      ).toBeNull();
    });

    for (const role of ['owner', 'manager', 'staff'] as const) {
      test(role + ' has the right profile, permission and sharing actions', async ({ page }) => {
        await installAuditSession(page, role);
        const studio = {
          id: 'loc',
          name: 'Studio DR',
          city: 'Warszawa',
          currency: 'PLN',
          slug: 'studio-dr',
          timezone: 'Europe/Warsaw',
          defaultLocale: 'pl',
          onlineBookingEnabled: false,
        };
        const me = { id: 'staff', userId: 'user', displayName: 'Ola', active: true, languages: [] };
        await page.route(org + '/locations', (route) =>
          route.fulfill({
            json: [studio, { ...studio, id: 'loc2', name: 'Filia' }],
          }),
        );
        await page.route('**' + auditBase, (route) => route.fulfill({ json: studio }));
        await page.route('**' + auditBase + '/staff', (route) => route.fulfill({ json: [me] }));
        await page.goto(app.url);
        await scaleAuditText(page, title(page, t.salons.title));
        const choice = button(page, studio.name);
        await expect(choice).toHaveAccessibleDescription(new RegExp(t.salons.role[role]));
        await expectAuditTextFits(choice);
        await choice.dblclick();
        const more = page.getByRole('tab', { name: t.navigation.more, exact: true });
        await more.click();
        await page.route('**' + auditBase + '/staff', (route) => route.abort(), { times: 1 });
        await button(page, t.profile.open).click();
        await expect(page.getByRole('alert')).toContainText(t.error.network);
        await button(page, t.day.refresh).dblclick();
        await expectAuditTextFits(page.getByText(t.profile.none, { exact: true }));
        await page.getByRole('checkbox', { name: 'UA · Українська' }).click();
        const save = button(page, t.profile.save);
        const write = gate();
        let writes = 0;
        await page.route('**' + auditBase + '/staff/staff/languages', async (route) => {
          expect(route.request().postDataJSON()).toEqual({ languages: ['uk'] });
          if (++writes === 1) {
            await write.pending;
            return route.abort();
          }
          return route.fulfill({ json: { ...me, languages: ['uk'] } });
        });
        try {
          await save.dblclick();
          await expect(save).toBeDisabled();
          await expect.poll(() => writes).toBe(1);
        } finally {
          write.release();
        }
        await expect(page.getByRole('alert')).toContainText(t.error.network);
        await expect(page.getByRole('checkbox', { name: 'UA · Українська' })).toBeChecked();
        await save.click();
        await expect(page.getByRole('status')).toHaveText(t.profile.saved);
        expect(writes).toBe(2);
        await button(page, t.profile.back).click();

        if (role === 'staff') {
          await expect(button(page, t.team.open)).toHaveCount(0);
          await expect(button(page, t.bookingLink.open)).toHaveCount(0);
          return;
        }

        await page.route(org + '/members', (route) => route.fulfill({ json: [] }));
        await page.route(org + '/invitations', (route) => route.fulfill({ json: [] }));
        await page.route(org + '/staff-categories', (route) => route.fulfill({ json: [] }));
        await page.route(org + '/staff-categories', (route) => route.abort(), { times: 1 });
        await button(page, t.team.open).click();
        await button(page, t.rights.open).click();
        await expect(page.getByRole('alert')).toContainText(t.error.network);
        await button(page, t.day.refresh).dblclick();
        await expectAuditTextFits(page.getByText(t.rights.noPeople, { exact: true }));
        await expect(page.getByText(t.rights.noCategories, { exact: true })).toBeVisible();
        if (role === 'owner') {
          await button(page, t.rights.addCategory).click();
          await button(page, t.rights.save).dblclick();
          await expect(page.getByRole('alert')).toContainText(t.rights.noName);
          await button(page, t.rights.cancel).click();
        } else {
          await expect(button(page, t.rights.addCategory)).toHaveCount(0);
          await expectAuditTextFits(page.getByText(t.rights.ownerOnly, { exact: true }));
        }
        await button(page, t.rights.back).click();
        await button(page, t.team.back).click();

        await page.route('**' + auditBase + '/staff', (route) => route.fulfill({ json: [] }));
        await page.route('**' + auditBase, (route) => route.abort(), { times: 1 });
        await button(page, t.bookingLink.open).click();
        await expect(page.getByRole('alert')).toContainText(t.error.network);
        await button(page, t.day.refresh).dblclick();
        await expectAuditTextFits(page.getByText(t.bookingLink.offline, { exact: true }));
        await expect(page.getByRole('img', { name: t.bookingLink.qrAlt })).toBeVisible();
        await expect(title(page, t.bookingLink.staffQrTitle)).toHaveCount(0);
        const dialog = gate();
        const urls: string[] = [];
        await page.exposeFunction('openAuditShareSheet', async (data: { url: string }) => {
          urls.push(data.url);
          await dialog.pending;
        });
        await page.evaluate(() =>
          Object.defineProperty(navigator, 'share', {
            value: Reflect.get(window, 'openAuditShareSheet'),
          }),
        );
        const share = button(page, t.bookingLink.share + ': ' + studio.name);
        try {
          await share.dblclick();
          await expect(share).toBeDisabled();
          await expect(button(page, t.bookingLink.shortShare + ': ' + studio.name)).toBeDisabled();
          await expect.poll(() => urls.length).toBe(1);
        } finally {
          dialog.release();
        }
        await expect(share).toBeEnabled();
        expect(urls).toHaveLength(1);
        expect(new URL(urls[0]!).pathname).toBe('/pl/b/studio-dr');
      });
    }
  });
}
