import { describe, expect, it, vi } from 'vitest';
import { bookingUrl } from '../src/api';
import { DICTIONARIES } from '../src/i18n';
import { shareMessage, shareSalon } from '../src/share';

const url = bookingUrl('https://app.example.com/', 'pl', 'gestalt-barbershop');
const content = shareMessage(DICTIONARIES.pl.salon.shareText, 'GESTALT BARBERSHOP', url);

describe('recommending a salon (task 151)', () => {
  it('sends the salon’s booking link with its name', () => {
    expect(url).toBe('https://app.example.com/pl/b/gestalt-barbershop');
    expect(content).toEqual({
      message:
        'GESTALT BARBERSHOP — umów się online: https://app.example.com/pl/b/gestalt-barbershop',
      url,
      title: 'GESTALT BARBERSHOP',
    });
  });

  it('every language has the link and the name in the text', () => {
    for (const d of Object.values(DICTIONARIES)) {
      expect(d.salon.shareText).toContain('{name}');
      expect(d.salon.shareText).toContain('{url}');
      expect(d.salon.shareFailed).toContain('{url}');
    }
  });

  it('uses the phone’s share sheet when there is one', async () => {
    const native = vi.fn().mockResolvedValue({ action: 'sharedAction' });
    const copy = vi.fn();
    expect(await shareSalon(content, { native, copy })).toBe('shared');
    expect(native).toHaveBeenCalledWith(content);
    expect(copy).not.toHaveBeenCalled();
    native.mockResolvedValue({ action: 'dismissedAction' });
    expect(await shareSalon(content, { native })).toBe('cancelled');
  });

  it('in a browser: its share menu, or the link is copied', async () => {
    const webShare = vi.fn().mockResolvedValue(undefined);
    expect(await shareSalon(content, { webShare })).toBe('shared');
    expect(webShare).toHaveBeenCalledWith({
      title: 'GESTALT BARBERSHOP',
      text: content.message,
      url,
    });

    const closed = Object.assign(new Error('closed'), { name: 'AbortError' });
    const copy = vi.fn().mockResolvedValue(undefined);
    expect(await shareSalon(content, { webShare: vi.fn().mockRejectedValue(closed), copy })).toBe(
      'cancelled',
    );
    expect(copy).not.toHaveBeenCalled();

    expect(await shareSalon(content, { copy })).toBe('copied');
    expect(copy).toHaveBeenCalledWith(url);
    expect(
      await shareSalon(content, { webShare: vi.fn().mockRejectedValue(new Error('nope')), copy }),
    ).toBe('copied');
  });

  it('says so when nothing works', async () => {
    expect(await shareSalon(content, {})).toBe('failed');
    expect(await shareSalon(content, { copy: vi.fn().mockRejectedValue(new Error('no')) })).toBe(
      'failed',
    );
  });
});
