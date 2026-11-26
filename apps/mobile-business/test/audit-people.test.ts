import { expect, it } from 'vitest';
import { historyTitle, type HistoryEntry } from '../src/history';
import { DICTIONARIES, LOCALES } from '../src/i18n';

// Actions emitted by salon settings, reviews, exports, scheduling and loyalty.
const actions = [
  'location.cancellation_guard_set',
  'location.review_settings_set',
  'review.reply_set',
  'review.reply_removed',
  'reviews.exported',
  'customers.exported',
  'customer.guard_released',
  'customer.guard_rule_set',
  'staff.commission_set',
  'loyalty.bonus_rules.replaced',
  'service.reordered',
  'service_category.reordered',
  'staff.languages_changed',
];

it.each(LOCALES)(
  'shows business activity to the owner in %s even after the entity was removed',
  (locale) => {
    for (const action of actions) {
      const entry: HistoryEntry = {
        id: 'event',
        at: '2026-11-26T10:00:00Z',
        action,
        actor: null,
        entityType: 'location',
        entityId: null,
        entityName: null,
        fields: null,
        date: null,
      };
      const title = historyTitle(entry, DICTIONARIES[locale]);
      expect(title, action).not.toContain(action);
      expect(title.trim().length).toBeGreaterThan(0);
      expect(historyTitle({ ...entry, entityName: 'Studio' }, DICTIONARIES[locale])).toBe(
        `${title}: Studio`,
      );
    }
  },
);
