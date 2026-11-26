import { afterEach, describe, expect, it, vi } from 'vitest';
import { locate, type Place } from '../src/location';

describe('catalog location when the permission prompt stays open', () => {
  afterEach(() => vi.useRealTimers());

  it('returns to city search after ten seconds and ignores late coordinates', async () => {
    vi.useFakeTimers();
    let grant!: (position: { coords: Place }) => void;
    const result = vi.fn();
    const lookup = locate({
      getCurrentPosition(ok) {
        grant = ok;
      },
    }).then(result);
    await vi.advanceTimersByTimeAsync(9999);
    expect(result).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toHaveBeenCalledExactlyOnceWith(null);

    grant({ coords: { latitude: 52.2, longitude: 21.0 } });
    await lookup;
    expect(result).toHaveBeenCalledTimes(1);
  });

  it('clears the deadline when the provider responds before it', async () => {
    vi.useFakeTimers();
    const coords = { latitude: 52.2, longitude: 21.0 };
    await expect(locate({ getCurrentPosition: (ok) => ok({ coords }) })).resolves.toEqual(coords);
    expect(vi.getTimerCount()).toBe(0);
  });
});
