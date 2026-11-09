import { describe, expect, it, vi } from 'vitest';
import { DICTIONARIES, fill } from '../src/i18n';
import { bookingLink, embedCode, shareCsv, shareLink, shortLink } from '../src/share';

const url = bookingLink('https://app.example.com/', {
  slug: 'gestalt-barbershop',
  defaultLocale: 'pl',
});
const content = {
  message: fill(DICTIONARIES.pl.bookingLink.message, { name: 'GESTALT', url }),
  url,
  title: 'GESTALT',
};

describe('booking link (task 152)', () => {
  it('is the salon’s booking page in its own language', () => {
    expect(url).toBe('https://app.example.com/pl/b/gestalt-barbershop');
    expect(bookingLink('http://localhost:3000', { slug: 'kyiv-barber', defaultLocale: 'uk' })).toBe(
      'http://localhost:3000/uk/b/kyiv-barber',
    );
    expect(content.message).toBe(
      'GESTALT — umów się online: https://app.example.com/pl/b/gestalt-barbershop',
    );
    for (const d of Object.values(DICTIONARIES)) expect(d.bookingLink.message).toContain('{url}');
  });

  it('uses the phone’s share sheet when there is one', async () => {
    const native = vi.fn().mockResolvedValue({ action: 'sharedAction' });
    expect(await shareLink(content, { native, copy: vi.fn() })).toBe('shared');
    native.mockResolvedValue({ action: 'dismissedAction' });
    expect(await shareLink(content, { native })).toBe('cancelled');
    native.mockRejectedValue(new Error('no'));
    expect(await shareLink(content, { native })).toBe('failed');
  });

  it('in a browser: its share menu, or the link is copied', async () => {
    expect(await shareLink(content, { webShare: vi.fn().mockResolvedValue(undefined) })).toBe(
      'shared',
    );
    const closed = Object.assign(new Error('closed'), { name: 'AbortError' });
    const copy = vi.fn().mockResolvedValue(undefined);
    expect(await shareLink(content, { webShare: vi.fn().mockRejectedValue(closed), copy })).toBe(
      'cancelled',
    );
    expect(await shareLink(content, { copy })).toBe('copied');
    expect(copy).toHaveBeenCalledWith(url);
    expect(await shareLink(content, {})).toBe('failed');
  });
});

describe('the report as CSV (task 220)', () => {
  const file = { fileName: 'visits-2026-11-01-2026-11-30.csv', csv: '\uFEFFData;Godzina\n' };

  it('in a browser the file is saved', async () => {
    const download = vi.fn();
    expect(await shareCsv(file, { download })).toBe('downloaded');
    expect(download).toHaveBeenCalledWith(file.fileName, file.csv);
    expect(
      await shareCsv(file, {
        download: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('failed');
  });

  it('on a phone its text goes to the share sheet, without the byte order mark', async () => {
    const native = vi.fn().mockResolvedValue({ action: 'sharedAction' });
    expect(await shareCsv(file, { native })).toBe('shared');
    expect(native).toHaveBeenCalledWith({ title: file.fileName, message: 'Data;Godzina\n' });
    native.mockResolvedValue({ action: 'dismissedAction' });
    expect(await shareCsv(file, { native })).toBe('cancelled');
    native.mockRejectedValue(new Error('no'));
    expect(await shareCsv(file, { native })).toBe('failed');
    expect(await shareCsv(file, {})).toBe('failed');
  });
});

describe('short link and website button (task 355)', () => {
  it('gives the cabinet’s short link and embed code', () => {
    const salon = { slug: 'gestalt-barbershop', defaultLocale: 'pl' as const };
    expect(shortLink('https://app.example.com/', salon)).toBe(
      'https://app.example.com/s/gestalt-barbershop',
    );
    expect(embedCode('https://app.example.com/', salon)).toBe(
      '<script src="https://app.example.com/embed.js" data-salon="gestalt-barbershop" data-lang="pl" async></script>',
    );
    expect(
      embedCode('http://localhost:3000', { slug: 'kyiv-barber', defaultLocale: 'uk' }),
    ).toContain('data-lang="uk"');
  });
});
