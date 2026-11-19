'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { parseTip as parseAmount } from '@/components/calendar/TipField';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { useSubmitLock } from '@/lib/submit-lock';
import { formatPrice } from '@/lib/time';
import type { GiftVoucherDetails, VisitVoucherPayments } from '@/lib/types';
import { ErrorBox } from '../ui';

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

  async function pay(e: FormEvent) {
    e.preventDefault();
    setError('');
    setInfo('');
    const wanted = code.trim().toUpperCase().replace(/[\s-]/g, '');
    if (wanted.length < 4) return setError(v.notFound);
    const grosze = parseAmount(amount);
    if (!grosze) return setError(v.wrongAmount);
    if (!lock()) return;
    try {
      let voucher: GiftVoucherDetails;
      try {
        voucher = await api<GiftVoucherDetails>(
          `${base}/gift-vouchers/code/${encodeURIComponent(wanted)}`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return setError(v.notFound);
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
      setError(errorText(t, err));
    } finally {
      unlock();
    }
  }

  if (!payments) return error ? <ErrorBox>{error}</ErrorBox> : null;

  return (
    <div className="stack" style={{ gap: 6 }} data-testid="visit-vouchers">
      {payments.payments.length > 0 ? (
        <>
          <span className="small muted">
            {fill(v.visitPaid, { amount: money(payments.totalGrosze) })}
          </span>
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
          onSubmit={(e) => void pay(e)}
          aria-label={v.pay}
        >
          <label className="field" style={{ flex: '1 1 9rem' }}>
            <span>{v.code}</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={20}
              autoComplete="off"
              autoCapitalize="characters"
              placeholder="ABCD-EFGH"
              data-testid="visit-voucher-code"
            />
          </label>
          <label className="field" style={{ flex: '0 1 7rem' }}>
            <span>{v.payAmount}</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              data-testid="visit-voucher-amount"
            />
          </label>
          <button type="submit" className="btn btn--small" disabled={busy || !code.trim()}>
            {v.pay}
          </button>
          <button
            type="button"
            className="btn btn--quiet btn--small"
            onClick={() => {
              setOpen(false);
              setError('');
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
