import type { Page } from '@playwright/test';

/**
 * Task Q6: "Ustawienia" in the cabinet is a list of sections; each opens its own card (on a
 * computer the list stays on the left). Opens the section whose title starts with `title`.
 */
export async function openSettingsCard(page: Page, title: string): Promise<void> {
  await page
    .locator('.settings-nav')
    .getByRole('button', { name: new RegExp(`^${title}`) })
    .click();
  await page.locator('.settings-card h2', { hasText: title }).first().waitFor();
}
