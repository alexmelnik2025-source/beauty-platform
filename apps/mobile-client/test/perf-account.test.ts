import { createElement, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import type { ClientLoyaltyCard } from '../src/api';
import * as bonus from '../src/bonus';
import { DICTIONARIES } from '../src/i18n';
import { BonusesView } from '../src/screens/BonusesView';

vi.mock('react-native', () => vi.importActual('react-native-web'));

const { renderToStaticMarkup } = await vi.importActual<{
  renderToStaticMarkup(node: ReactNode): string;
}>('react-dom/server');

it('renders every balance without formatting collapsed bonus rules', () => {
  const items: ClientLoyaltyCard[] = Array.from({ length: 12 }, (_, index) => ({
    organization: { id: String(index), name: 'Studio ' + index },
    bookingSlug: null,
    enabled: true,
    currency: 'PLN',
    balance: index,
    lifetimeEarned: index,
    mode: 'points',
    earning: {
      stampsPerVisit: 0,
      pointsPerUnit: 1,
      spendUnitGrosze: 1000,
      minSpendGrosze: 0,
      pointsValidityDays: null,
    },
    next: null,
    rewards: [],
    history: [],
    coupons: [],
    tier: null,
    bonuses: Array.from({ length: 3 }, (_, n) => ({
      name: 'Double ' + n,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      multiplier: 2,
      extraPoints: 0,
      staffNames: [],
      withinDays: null,
    })),
  }));
  const formatRule = vi.spyOn(bonus, 'extraText');
  try {
    const markup = renderToStaticMarkup(
      createElement(BonusesView, { t: DICTIONARIES.en, locale: 'en', items, onBook: () => {} }),
    );
    expect(markup.match(/role="region"/g)).toHaveLength(items.length);
    expect(markup).toContain(DICTIONARIES.en.bonuses.balancePoints.replace('{count}', '11'));
    expect(formatRule).not.toHaveBeenCalled();
  } finally {
    formatRule.mockRestore();
  }
});
