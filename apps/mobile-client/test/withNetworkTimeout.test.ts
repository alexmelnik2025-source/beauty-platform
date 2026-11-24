import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withNetworkTimeout } from '../src/withNetworkTimeout';

describe('withNetworkTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the response and clears the timeout', async () => {
    const response = { openNowCount: 3 };
    await expect(withNetworkTimeout(Promise.resolve(response))).resolves.toBe(response);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the request error and clears the timeout', async () => {
    const error = new Error('offline');
    await expect(withNetworkTimeout(Promise.reject(error))).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out at 30 seconds and ignores a late response', async () => {
    const { promise, resolve } = Promise.withResolvers<string>();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const result = withNetworkTimeout(promise);
    const observed = result.then(onSuccess, onFailure);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await observed;
    const error = onFailure.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe('Network request timed out');

    resolve('late response');
    await expect(result).rejects.toBe(error);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
