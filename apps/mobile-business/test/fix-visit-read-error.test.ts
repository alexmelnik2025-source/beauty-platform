import { createElement, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { DICTIONARIES, LOCALES } from '../src/i18n';
import { VisitReadError } from '../src/screens/VisitCouponsSection';

vi.mock('react-native', () => vi.importActual('react-native-web'));

const { renderToStaticMarkup } = await vi.importActual<{
  renderToStaticMarkup(node: ReactNode): string;
}>('react-dom/server');

it.each(LOCALES)('keeps each failed visit section identifiable during a retry in %s', (locale) => {
  const t = DICTIONARIES[locale];
  for (const title of [t.visit.coupons.title, t.products.sold, t.vouchers.title]) {
    const render = (retrying: boolean) =>
      renderToStaticMarkup(
        createElement(VisitReadError, {
          title,
          message: t.error.network,
          refresh: t.day.refresh,
          retrying,
          onRetry: vi.fn(),
        }),
      ).replaceAll('&#x27;', "'");

    const ready = render(false);
    const pending = render(true);
    for (const markup of [ready, pending]) {
      expect(markup).toContain('role="alert"');
      expect(markup).toContain(t.error.network);
      expect(markup).toContain(`aria-label="${t.day.refresh}: ${title}"`);
    }
    expect(ready).not.toContain('aria-disabled="true"');
    expect(pending).toContain('aria-disabled="true"');
  }
});
