import { createElement, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { DICTIONARIES } from '../src/i18n';
import { OpenNow } from '../src/OpenNow';

vi.mock('react-native', () => vi.importActual('react-native-web'));

const { renderToStaticMarkup } = await vi.importActual<{
  renderToStaticMarkup(node: ReactNode): string;
}>('react-dom/server');

it('formats the clock once per zone and minute but keeps the hours of every salon', () => {
  const format = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-26T10:59:00Z'));
  const renderStatus = (timezone: string, end: string) =>
    renderToStaticMarkup(
      createElement(OpenNow, {
        t: DICTIONARIES.en,
        locale: 'en',
        salon: { timezone, todayHours: [{ start: '00:00', end }] },
      }),
    );
  try {
    for (let i = 0; i < 20; i++) {
      const end = i % 2 ? '12:00' : '13:00';
      expect(renderStatus('Europe/Warsaw', end)).toContain(end);
    }
    expect(format).toHaveBeenCalledTimes(1);

    // At this instant it is already 20:59 in Tokyo.
    expect(renderStatus('Asia/Tokyo', '12:00')).toContain(DICTIONARIES.en.salon.closedNow);
    expect(format).toHaveBeenCalledTimes(2);

    clock.mockReturnValue(Date.parse('2026-11-26T11:00:00Z'));
    expect(renderStatus('Europe/Warsaw', '12:00')).toContain(DICTIONARIES.en.salon.closedNow);
    expect(format).toHaveBeenCalledTimes(3);
  } finally {
    format.mockRestore();
    clock.mockRestore();
  }
});
