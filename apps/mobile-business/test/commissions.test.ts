import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BusinessApi, type SalonReport } from '../src/api';
import { parsePercent, percentInput, percentText } from '../src/commissions';
import { formatPrice } from '../src/day';
import { DICTIONARIES } from '../src/i18n';
import { CommissionsSection } from '../src/screens/CommissionsSection';

vi.mock('react-native', () => vi.importActual('react-native-web'));

const { renderToStaticMarkup } = await vi.importActual<{
  renderToStaticMarkup(node: ReactNode): string;
}>('react-dom/server');

describe('commissions (task 375)', () => {
  it('reads what the owner types', () => {
    expect(parsePercent('40')).toBe(40);
    expect(parsePercent(' 42,5 ')).toBe(42.5);
    expect(parsePercent('42.5')).toBe(42.5);
    expect(parsePercent('0')).toBe(0);
    expect(parsePercent('100')).toBe(100);
    expect(parsePercent('')).toBeNull();
    for (const bad of ['42,55', '101', '-1', '4o', '1e2', '100,1', '100.1']) {
      expect(parsePercent(bad)).toBeUndefined();
    }
  });

  it('shows a percent in the app language', () => {
    expect(percentText(45.5, 'pl')).toBe('45,5%');
    expect(percentText(40, 'en')).toBe('40%');
    expect(percentInput(42.5, 'en')).toBe('42.5');
    expect(percentInput(null, 'pl')).toBe('');
  });

  it.each(['pl', 'en', 'uk', 'ru'] as const)('round-trips both limits in %s', (locale) => {
    for (const percent of [0, 0.1, 99.9, 100]) {
      const input = percentInput(percent, locale);
      expect(parsePercent(input)).toBe(percent);
      expect(percentText(percent, locale)).toBe(`${input}%`);
    }
    expect(percentText(0, locale)).toBe('0%');
    expect(percentText(100, locale)).toBe('100%');
  });
});

// The API supplies whole grosze. Exercise the report that consumes the commission helpers
// so the test checks the amount the specialist sees, including tips.
function renderOwnCommission(staff: SalonReport['staff'], tips: SalonReport['tips']) {
  return renderToStaticMarkup(
    createElement(CommissionsSection, {
      report: { scope: 'own', staff, tips } as SalonReport,
      api: new BusinessApi('', { get: vi.fn(), set: vi.fn() }),
      salon: {
        orgId: 'org',
        orgName: 'Org',
        role: 'staff',
        locationId: 'salon',
        locationName: 'Salon',
        city: 'Warsaw',
        currency: 'PLN',
      },
      locale: 'pl',
      t: DICTIONARIES.pl,
      money: (grosze) => formatPrice(grosze, 'PLN', 'pl'),
      onSaved: vi.fn(),
    }),
  );
}

it('shows no payout for a specialist without visits', () => {
  expect(renderOwnCommission([], { totalGrosze: 0, visits: 0, staff: [] })).toBe('');
});

it.each([
  // 50% of 101 grosze is 50.5 grosze, rounded by the API to 51.
  { percent: 50, commission: 51, payout: '0,58' },
  { percent: 0, commission: 0, payout: '0,07' },
  { percent: 100, commission: 101, payout: '1,08' },
])(
  'shows the rounded commission at $percent% plus the full tip',
  ({ percent, commission, payout }) => {
    const staff = { id: 'a', displayName: 'Anna' };
    const html = renderOwnCommission(
      [
        {
          ...staff,
          completed: 1,
          paid: 1,
          noShow: 0,
          cancelledByClient: 0,
          cancelledBySalon: 0,
          revenueGrosze: 101,
          commissionPercent: percent,
          commissionGrosze: commission,
        },
      ],
      { totalGrosze: 7, visits: 1, staff: [{ ...staff, tipsGrosze: 7, visits: 1 }] },
    );
    expect(html).toContain(`${percent}% · ${formatPrice(commission, 'PLN', 'pl')}`);
    expect(html).toContain(`Razem do wypłaty (z napiwkami): ${payout}\u00a0zł`);
  },
);
