'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { parseTip as parseAmount } from '@/components/calendar/TipField';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { useSubmitLock } from '@/lib/submit-lock';
import { formatPrice } from '@/lib/time';
import type { GiftVoucherDetails, VisitVoucherPayments } from '@/lib/types';
import { ErrorBox, FieldError } from '../ui';

/** "ABCDEFGH" → "ABCD-EFGH", as printed on the voucher. */
const shown = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Grosze as typed in the amount field: "80" or "49,50". */
const typed = (grosze: number) =>
  grosze % 100 === 0 ? String(grosze / 100) : (grosze / 100).toFixed(2).replace('.', ',');

/**
 * Task 541: "Zapłać bonem" in the card of a visit that took place — the client pays the whole visit
 * or a part of it with a gift voucher: the code from the voucher and the amount (what is left to
 * pay for the visit is filled in). The payment belongs to the visit and is listed here; the
 * voucher keeps its own history ("Bony podarunkowe"). Everyone who sees the visit may do it.
 */
/** Task 673: which field of "Zapłać bonem" the server's answer is about; null — none of them. */
function voucherFieldOf(err: unknown): 'code' | 'amount' | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'VOUCHER_BALANCE') return 'amount';
  if (err.code === 'VOUCHER_EXPIRED' || err.code === 'VOUCHER_CANCELLED') return 'code';
  if (err.code !== 'VALIDATION_ERROR' || !Array.isArray(err.details)) return null;
  const paths = (err.details as { path?: string }[]).map((d) => d.path);
  return paths.includes('amountGrosze') ? 'amount' : null;
}

export function VisitVouchers({
  base,
  appointmentId,
  currency,
  toPayGrosze,
  serviceName,
}: {
  /** …/organizations/:orgId/locations/:locationId */
  base: string;
  appointmentId: string;
  currency: string;
  /** The visit price after discounts; null when the service has no price. */
  toPayGrosze: number | null;
  serviceName: string;
}) {
  const { t, locale } = useI18n();
  const v = t.vouchers;
  const tag = LOCALE_TAGS[locale];
  const money = (n: number) => formatPrice(n, currency, tag);
  const [payments, setPayments] = useState<VisitVoucherPayments | null>(null);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  /**
   * Task 673 (owner's rule: errors at the field): an unknown, expired or cancelled voucher is said
   * under "Kod bonu", a wrong amount or one above what is left under the amount; the field gets the
   * cursor and editing it takes the error away.
   */
  const [problem, setProblem] = useState<{ field: 'code' | 'amount'; text: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [info, setInfo] = useState('');
  const { lock, unlock, busy } = useSubmitLock();
  const url = `${base}/appointments/${appointmentId}/gift-voucher-payments`;

  const load = useCallback(async () => {
    try {
      setPayments(await api<VisitVoucherPayments>(url));
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [url, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const left =
    toPayGrosze === null || !payments ? null : Math.max(0, toPayGrosze - payments.totalGrosze);

  function start() {
    setOpen(true);
    setInfo('');
    setAmount(left ? typed(left) : '');
  }

  useEffect(() => {
    if (!problem) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [problem]);

  async function pay(e: FormEvent) {
    e.preventDefault();
    setError('');
    setProblem(null);
    setInfo('');
    const wanted = code.trim().toUpperCase().replace(/[\s-]/g, '');
    // Task 682: an empty code is said under the field (the button no longer stays silently off).
    if (!wanted) return setProblem({ field: 'code', text: t.onboarding.fieldRequired });
    if (wanted.length < 4) return setProblem({ field: 'code', text: v.notFound });
    const grosze = parseAmount(amount);
    if (!grosze) return setProblem({ field: 'amount', text: v.wrongAmount });
    if (!lock()) return;
    try {
      let voucher: GiftVoucherDetails;
      try {
        voucher = await api<GiftVoucherDetails>(
          `${base}/gift-vouchers/code/${encodeURIComponent(wanted)}`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          return setProblem({ field: 'code', text: v.notFound });
        }
        throw err;
      }
      const next = await api<GiftVoucherDetails>(
        `${base}/gift-vouchers/${voucher.voucher.id}/redeem`,
        {
          method: 'POST',
          body: { amountGrosze: grosze, appointmentId, note: serviceName.slice(0, 120) },
        },
      );
      setInfo(fill(v.paid, { amount: money(grosze), left: money(next.voucher.balanceGrosze) }));
      setCode('');
      setOpen(false);
      await load();
    } catch (err) {
      const field = voucherFieldOf(err);
      if (field) setProblem({ field, text: errorText(t, err) });
      else setError(errorText(t, err));
    } finally {
      unlock();
    }
  }

  if (!payments) return error ? <ErrorBox>{error}</ErrorBox> : null;

  /** Editing a field takes its error away. */
  const clear = (field: 'code' | 'amount') => {
    if (problem?.field === field) setProblem(null);
  };
  const errorId = (field: 'code' | 'amount') => `visit-voucher-${field}-error-${appointmentId}`;
  const invalid = (field: 'code' | 'amount') => ({
    'aria-invalid': problem?.field === field || undefined,
    'aria-describedby': problem?.field === field ? errorId(field) : undefined,
  });
  const fieldError = (field: 'code' | 'amount') => (
    <FieldError id={errorId(field)} text={problem?.field === field ? problem.text : undefined} />
  );

  return (
    <div className="stack" style={{ gap: 6 }} data-testid="visit-vouchers">
      {payments.payments.length > 0 ? (
        <>
          <span className="small muted">
            {fill(v.visitPaid, { amount: money(payments.totalGrosze) })}
          </span>
          {/* Task 545: what the client still pays for the visit after the vouchers. */}
          {left === null || payments.totalGrosze <= 0 ? null : (
            <span className="small" data-testid="visit-voucher-left">
              {left > 0 ? fill(v.visitLeft, { amount: money(left) }) : v.visitCovered}
            </span>
          )}
          <ul className="commission-list">
            {payments.payments.map((p) => (
              <li
                key={p.id}
                className="commission-row"
                style={p.undoneDate ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}
              >
                <span style={{ flex: '1 1 10rem' }}>
                  <span className="coupon-code">{shown(p.code)}</span>
                  <span className="small muted">
                    {' · '}
                    {p.time}
                    {p.byName ? ` · ${p.byName}` : ''}
                    {p.undoneDate ? ` · ${v.undoneMark}` : ''}
                  </span>
                </span>
                <span>{money(p.amountGrosze)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {info ? (
        <p className="note" role="status">
          {info}
        </p>
      ) : null}
      {open ? (
        <form
          className="row"
          style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
          ref={formRef}
          onSubmit={(e) => void pay(e)}
          aria-label={v.pay}
        >
          <label className="field" style={{ flex: '1 1 9rem' }}>
            <span>{v.code}</span>
            <input
              value={code}
              {...invalid('code')}
              onChange={(e) => {
                setCode(e.target.value);
                clear('code');
              }}
              maxLength={20}
              autoComplete="off"
              autoCapitalize="characters"
              placeholder="ABCD-EFGH"
              data-testid="visit-voucher-code"
            />
            {fieldError('code')}
          </label>
          <label className="field" style={{ flex: '0 1 7rem' }}>
            <span>{v.payAmount}</span>
            <input
              value={amount}
              {...invalid('amount')}
              onChange={(e) => {
                setAmount(e.target.value);
                clear('amount');
              }}
              inputMode="decimal"
              data-testid="visit-voucher-amount"
            />
            {fieldError('amount')}
          </label>
          <button type="submit" className="btn btn--small" disabled={busy}>
            {v.pay}
          </button>
          <button
            type="button"
            className="btn btn--quiet btn--small"
            onClick={() => {
              setOpen(false);
              setError('');
              setProblem(null);
            }}
          >
            {t.common.cancel}
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="link-btn small"
          style={{ alignSelf: 'flex-start' }}
          onClick={start}
          data-testid="visit-voucher-open"
        >
          {v.visitOpen}
        </button>
      )}
      <ErrorBox>{error}</ErrorBox>
    </div>
  );
}
