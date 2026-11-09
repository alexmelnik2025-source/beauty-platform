import { describe, expect, it } from 'vitest';
import type { DayVisit } from '../src/day';
import { dayPlanText } from '../src/dayPlan';
import { shareText } from '../src/share';
import { pl } from '../src/locales/pl';

const labels = {
  working: pl.day.working,
  nobodyWorks: pl.day.nobodyWorks,
  empty: pl.day.empty,
  blocks: pl.blocks.title,
  wholeSalon: pl.blocks.wholeSalon,
  walkIn: pl.day.walkIn,
  awaitingApproval: pl.visit.awaitingApproval,
};

const visit = (over: Partial<DayVisit>): DayVisit => ({
  id: 'a1',
  start: '09:00',
  end: '09:45',
  status: 'confirmed',
  service: 'Strzyżenie',
  staff: 'Kasia',
  staffId: 's1',
  customer: 'Jan Kowalski',
  phone: '+48600100200',
  waiting: false,
  birthday: false,
  ...over,
});

describe('dayPlanText (task 351)', () => {
  it('lists who works, the visits and the blocked time', () => {
    const text = dayPlanText(
      {
        salon: 'Gestalt Barbershop',
        title: 'wtorek, 10 listopada',
        visits: [
          visit({}),
          visit({
            start: '10:00',
            end: '10:30',
            staff: 'Olek',
            service: 'Broda',
            phone: null,
            waiting: true,
          }),
          visit({ start: '11:00', end: '11:30', customer: null, phone: null }),
        ],
        working: [
          { name: 'Kasia', hours: '08:00–16:00' },
          { name: 'Olek', hours: '10:00–18:00' },
        ],
        blocks: [
          {
            id: 'b1',
            start: '13:00',
            end: '14:00',
            staffId: 's1',
            staff: 'Kasia',
            reason: 'Przerwa',
            seriesId: null,
          },
          {
            id: 'b2',
            start: '17:00',
            end: '18:00',
            staffId: null,
            staff: null,
            reason: null,
            seriesId: null,
          },
        ],
      },
      labels,
    );
    expect(text).toBe(
      [
        'Gestalt Barbershop — wtorek, 10 listopada',
        '',
        'Pracują: Kasia 08:00–16:00 · Olek 10:00–18:00',
        '',
        '09:00–09:45 · Kasia · Strzyżenie — Jan Kowalski, +48600100200',
        '10:00–10:30 · Olek · Broda — Jan Kowalski (Czeka na potwierdzenie)',
        '11:00–11:30 · Kasia · Strzyżenie — Klient bez karty',
        '',
        'Zablokowany czas:',
        '13:00–14:00 · Kasia — Przerwa',
        '17:00–18:00 · Cały salon',
      ].join('\n'),
    );
  });

  it('says so when nobody works and there are no visits', () => {
    expect(
      dayPlanText({ salon: 'S', title: 'niedziela', visits: [], working: [], blocks: [] }, labels),
    ).toBe(
      ['S — niedziela', '', 'Nikt nie pracuje tego dnia.', '', 'Brak wizyt tego dnia.'].join('\n'),
    );
  });
});

describe('shareText (task 351)', () => {
  const content = { title: 'Plan dnia', message: 'S — niedziela' };

  it('uses the share sheet on a phone', async () => {
    const seen: unknown[] = [];
    const native = async (c: unknown) => {
      seen.push(c);
      return { action: 'sharedAction' };
    };
    await expect(shareText(content, { native })).resolves.toBe('shared');
    expect(seen).toEqual([content]);
    await expect(
      shareText(content, { native: async () => ({ action: 'dismissedAction' }) }),
    ).resolves.toBe('cancelled');
  });

  it('copies the whole text when the browser has no share menu', async () => {
    let copied = '';
    await expect(
      shareText(content, {
        copy: async (text) => {
          copied = text;
        },
      }),
    ).resolves.toBe('copied');
    expect(copied).toBe('S — niedziela');
    await expect(shareText(content, {})).resolves.toBe('failed');
  });

  it('falls back to copying when the share menu fails, but not when it is closed', async () => {
    const copy = async () => undefined;
    const abort = Object.assign(new Error('closed'), { name: 'AbortError' });
    await expect(shareText(content, { webShare: () => Promise.reject(abort), copy })).resolves.toBe(
      'cancelled',
    );
    await expect(
      shareText(content, { webShare: () => Promise.reject(new Error('no')), copy }),
    ).resolves.toBe('copied');
  });
});
