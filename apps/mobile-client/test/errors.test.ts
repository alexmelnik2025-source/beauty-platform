import { describe, expect, it, vi } from 'vitest';
import { ApiError, ClientApi } from '../src/api';
import { errorText, formFailure, isCodeError, validationField } from '../src/errors';
import { DICTIONARIES } from '../src/i18n';

const t = DICTIONARIES.pl;

describe('client form errors', () => {
  it('distinguishes an incorrect code from a code that must be requested again', () => {
    for (const [code, message] of [
      ['INVALID_CODE', t.signIn.badCode],
      ['CODE_EXPIRED', t.signIn.newCodeNeeded],
      ['CODE_NOT_SENT', t.signIn.newCodeNeeded],
      ['TOO_MANY_ATTEMPTS', t.signIn.newCodeNeeded],
    ] as const) {
      const error = new ApiError(400, 'Server message', code);
      expect(isCodeError(error)).toBe(true);
      expect(errorText(error, t)).toBe(message);
    }
    expect(isCodeError(new ApiError(429, '', 'TOO_MANY_CODES'))).toBe(false);
  });

  it.each([
    [400, t.error.generic],
    [404, t.error.notFound],
    [429, t.error.tooMany],
  ] as const)('uses the status fallback for an unknown code on HTTP %i', (status, message) => {
    const error = new ApiError(status, 'Internal server detail', 'UNRECOGNIZED_CODE');
    expect(isCodeError(error)).toBe(false);
    expect(formFailure(error, t, vi.fn())).toEqual({ message });
  });

  it.each([
    [404, t.error.notFound, false],
    [503, t.error.network, true],
  ] as const)('handles HTTP %i with an empty response body', async (status, message, retryable) => {
    const api = new ClientApi(
      'https://app.example.com',
      { get: vi.fn(), set: vi.fn() },
      async () => new Response(null, { status }),
    );
    const retry = vi.fn();
    const feedback = api
      .requestCode('anna@example.com', 'pl')
      .catch((error: unknown) => formFailure(error, t, retry));
    await expect(feedback).resolves.toEqual(retryable ? { message, retry } : { message });
  });

  it.each([
    { details: undefined },
    {
      details: [
        { path: 'amountGrosze', message: '5500' },
        { path: 'currency', message: 'PLN' },
      ],
    },
  ])('shows payment instructions with or without disclosed amount details', ({ details }) => {
    const error = new ApiError(403, 'Payment required', 'BOOKING_PAY_FIRST', details);
    expect(formFailure(error, t, vi.fn())).toEqual({ message: t.error.payFirst });
  });

  it('matches supported field paths and ignores malformed details', () => {
    const error = new ApiError(400, '', 'VALIDATION_ERROR', [
      null,
      {},
      { path: 'other' },
      { path: 'wishes.note' },
      { path: 'phone' },
    ]);
    expect(validationField(error, ['wishes.note'])).toBe('wishes.note');
    expect(validationField(error, ['name', 'phone'])).toBe('phone');
    expect(validationField(error, ['email'])).toBeUndefined();
    expect(
      validationField(new ApiError(400, '', 'VALIDATION_ERROR', {}), ['email']),
    ).toBeUndefined();
  });

  it('offers the failed action again only for network failures', () => {
    const retry = vi.fn();
    for (const error of [new TypeError('Network request failed'), new ApiError(503, '')]) {
      const feedback = formFailure(error, t, retry);
      expect(feedback.message).toBe(t.error.network);
      feedback.retry?.();
    }
    expect(retry).toHaveBeenCalledTimes(2);
    expect(formFailure(new ApiError(429, ''), t, retry)).toEqual({ message: t.error.tooMany });
    expect(formFailure(new ApiError(400, '', 'BOOKING_PAY_FIRST'), t, retry)).toEqual({
      message: t.error.payFirst,
    });
  });
});
