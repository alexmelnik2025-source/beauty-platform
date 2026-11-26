import { expect, type Locator } from '@playwright/test';

export const auditLocales = ['pl', 'en', 'uk', 'ru'] as const;

// Expo web specifies typography in pixels. Scale the actual font and line spacing while
// keeping the viewport fixed. Newly mounted screens share these stylesheet rules.
export async function enlargeText(sample: Locator) {
  await expect(sample).toBeVisible();
  const fontSize = () => sample.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const original = await fontSize();
  await sample.page().evaluate(() => {
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
  expect(await fontSize()).toBeCloseTo(original * 1.3, 1);
  expect(await sample.page().evaluate(() => document.documentElement.clientWidth)).toBe(320);
}

export async function expectFits(element: Locator) {
  await expect(element).toBeVisible();
  const layout = await element.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      withinWidth: box.left >= -1 && box.right <= document.documentElement.clientWidth + 1,
      contentFits: el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1,
      pageWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout).toEqual({ withinWidth: true, contentFits: true, pageWidth: 320 });
}
