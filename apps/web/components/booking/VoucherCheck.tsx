'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { PublicGiftVoucher } from '@/lib/types';
import { FieldError } from '../ui';

/** "17 lutego 2027": a voucher may be valid into the next year, so the year is shown. */
function dayWithYear(date: string, tag: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(tag, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Task 537: "Sprawdź bon" on the salon page — a client with a gift voucher of this salon types its
 * code and sees what is left and until when. Only the value and the dates: who it is for and the
 * payments stay in the salon. Folded until the client opens it, or opened with the code from
 * `?bon=` (task 539).
 */
export function VoucherCheck({ slug }: { slug: string }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [open, setOpen] = useState(false);
  // Opened by the client's tap (not by a `?bon=` link): the cursor goes to the code field.
  const [focusCode, setFocusCode] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [voucher, setVoucher] = useState<PublicGiftVoucher | null>(null);

  const lookUp = useCallback(
    async (typed: string) => {
      setBusy(true);
      setError('');
      setVoucher(null);
      try {
        setVoucher(
          await api<PublicGiftVoucher>(
            `/v1/public/locations/${encodeURIComponent(slug)}/gift-vouchers/${encodeURIComponent(typed)}`,
            { auth: false },
          ),
        );
      } catch (err) {
        setError(
          err instanceof ApiError && err.status === 404
            ? t.voucherCheck.notFound
            : errorText(t, err),
        );
      } finally {
        setBusy(false);
      }
    },
    [slug, t],
  );

  // Task 539: the QR code on a printed voucher opens the page with `?bon=<code>` — the answer is
  // shown at once.
  useEffect(() => {
    const fromLink = new URLSearchParams(window.location.search).get('bon')?.trim() ?? '';
    if (fromLink.length < 4) return;
    setOpen(true);
    setCode(fromLink);
    void lookUp(fromLink);
  }, [lookUp]);

  function check(event: FormEvent) {
    event.preventDefault();
    const typed = code.trim();
    if (busy) return;
    // Task 706 (owner's rule: errors at the field): an empty or too short code is said under the
    // field (the button was silently switched off). No code this short exists, so "not found".
    if (typed.length < 4) {
      setVoucher(null);
      setError(typed ? t.voucherCheck.notFound : t.onboarding.fieldRequired);
      document.getElementById('voucher-check-code')?.focus();
      return;
    }
    void lookUp(typed);
  }

  if (!open) {
    return (
      <div className="voucher-check">
        <button
          type="button"
          className="btn btn--quiet btn--small"
          onClick={() => {
            setFocusCode(true);
            setOpen(true);
          }}
        >
          {t.voucherCheck.open}
        </button>
      </div>
    );
  }

  const status = voucher
    ? {
        active: t.voucherCheck.statusActive,
        used: t.voucherCheck.statusUsed,
        expired: t.voucherCheck.statusExpired,
        cancelled: t.voucherCheck.statusCancelled,
      }[voucher.status]
    : '';
  const money = (value: number) => formatPrice(value, voucher?.currency ?? 'PLN', tag);

  return (
    <section className="stack voucher-check" aria-labelledby="voucher-check-title">
      <h2 id="voucher-check-title">{t.voucherCheck.title}</h2>
      <p className="small muted">{t.voucherCheck.hint}</p>
      <form noValidate className="voucher-check-form" onSubmit={check}>
        <label className="field">
          <span>{t.voucherCheck.code}</span>
          <input
            id="voucher-check-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError('');
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'voucher-code-error' : undefined}
            autoFocus={focusCode}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={20}
            placeholder="ABCD-EFGH"
          />
        </label>
        <button type="submit" className="btn btn--small" disabled={busy}>
          {t.voucherCheck.check}
        </button>
      </form>
      {/* Task Q5: the error at the code field — a red frame, "!" and a short line under it. */}
      <FieldError id="voucher-code-error" text={error} />
      {voucher ? (
        <div className="note stack voucher-check-result" role="status">
          <strong>
            {fill(t.voucherCheck.left, {
              left: money(voucher.balanceGrosze),
              amount: money(voucher.amountGrosze),
            })}
          </strong>
          <span className="small">
            {status}
            {' · '}
            {voucher.validUntil
              ? fill(t.voucherCheck.validUntil, { date: dayWithYear(voucher.validUntil, tag) })
              : t.voucherCheck.noEnd}
          </span>
          {voucher.status === 'active' ? (
            <span className="small muted">{t.voucherCheck.payAtSalon}</span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
