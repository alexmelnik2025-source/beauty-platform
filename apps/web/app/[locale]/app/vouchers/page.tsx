'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { parseTip as parseAmount } from '@/components/calendar/TipField';
import { useSession } from '@/components/Session';
import { ErrorBox, Spinner } from '@/components/ui';
import { api, ApiError, apiResponse } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import type { Dict } from '@/lib/i18n/pl';
import { formatDay, formatPrice } from '@/lib/time';
import type { GiftVoucher, GiftVoucherDetails, GiftVoucherList } from '@/lib/types';
import { useSubmitLock } from '@/lib/submit-lock';

const STATUS: Record<GiftVoucher['status'], keyof Dict['vouchers']> = {
  active: 'statusActive',
  used: 'statusUsed',
  expired: 'statusExpired',
  cancelled: 'statusCancelled',
};

/** "Zostało 80,00 zł z 200,00 zł · Ważny do … · Dla: Jan". */
function VoucherSummary({ voucher }: { voucher: GiftVoucher }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const { location } = useSession();
  const money = (n: number) => formatPrice(n, location.currency, tag);
  return (
    <>
      <span>
        <strong className="coupon-code">{voucher.code}</strong>{' '}
        <span className="chip">{t.vouchers[STATUS[voucher.status]]}</span>
      </span>
      <span className="small">
        {fill(t.vouchers.left, {
          left: money(voucher.balanceGrosze),
          amount: money(voucher.amountGrosze),
        })}
        {' · '}
        {voucher.validUntil
          ? fill(t.vouchers.validUntil, { date: formatDay(voucher.validUntil, tag) })
          : t.vouchers.noEnd}
      </span>
      {voucher.recipient ? (
        <span className="small">{fill(t.vouchers.forWhom, { name: voucher.recipient })}</span>
      ) : null}
      {voucher.note ? <span className="small muted">{voucher.note}</span> : null}
    </>
  );
}

/**
 * Task 491: one voucher at the till — what is left, "Zapłać bonem" while it may be used, and the
 * payments made with it.
 */
function VoucherDetails({
  details,
  onChange,
}: {
  details: GiftVoucherDetails;
  onChange: (next: GiftVoucherDetails) => void;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const { orgId, location } = useSession();
  const base = `/v1/organizations/${orgId}/locations/${location.id}/gift-vouchers`;
  const money = (n: number) => formatPrice(n, location.currency, tag);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const { busy, lock, unlock } = useSubmitLock();
  const { voucher, uses } = details;

  async function pay(e: FormEvent) {
    e.preventDefault();
    setError('');
    setInfo('');
    const grosze = parseAmount(amount);
    if (!grosze) return setError(t.vouchers.wrongAmount);
    if (!lock()) return;
    try {
      const next = await api<GiftVoucherDetails>(`${base}/${voucher.id}/redeem`, {
        method: 'POST',
        body: { amountGrosze: grosze, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      onChange(next);
      setAmount('');
      setNote('');
      setInfo(
        fill(t.vouchers.paid, {
          amount: money(grosze),
          left: money(next.voucher.balanceGrosze),
        }),
      );
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      unlock();
    }
  }

  return (
    <div className="section" role="group" aria-label={voucher.code}>
      <div className="list-row" style={{ border: 0, padding: 0 }}>
        <span className="grow">
          <VoucherSummary voucher={voucher} />
        </span>
      </div>
      <ErrorBox>{error}</ErrorBox>
      {info ? (
        <p className="note" role="status">
          {info}
        </p>
      ) : null}
      {voucher.status === 'active' ? (
        <form className="form" onSubmit={(e) => void pay(e)}>
          <div className="row">
            <label className="field grow">
              <span>{t.vouchers.payAmount}</span>
              <input
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label className="field grow">
              <span>{t.vouchers.payNote}</span>
              <input maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
          <button className="btn" disabled={busy}>
            {t.vouchers.pay}
          </button>
        </form>
      ) : null}
      <h3>{t.vouchers.uses}</h3>
      {uses.length === 0 ? (
        <p className="small muted">{t.vouchers.noUses}</p>
      ) : (
        <ul className="list">
          {uses.map((u) => (
            <li key={u.id} className="list-row">
              <span className="grow">
                <strong>{money(u.amountGrosze)}</strong>
                <span className="small muted">
                  {formatDay(u.date, tag, { short: true })}, {u.time}
                  {u.byName ? ` · ${u.byName}` : ''}
                  {u.note ? ` · ${u.note}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Task 491: "Sprawdź bon" — everyone in the salon, by the code the client shows. */
function CheckVoucher({
  found,
  onFound,
}: {
  found: GiftVoucherDetails | null;
  onFound: (details: GiftVoucherDetails | null) => void;
}) {
  const { t } = useI18n();
  const { orgId, location } = useSession();
  const base = `/v1/organizations/${orgId}/locations/${location.id}/gift-vouchers`;
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const { busy, lock, unlock } = useSubmitLock();

  async function check(e: FormEvent) {
    e.preventDefault();
    const typed = code.trim();
    if (!typed || !lock()) return;
    setError('');
    onFound(null);
    try {
      onFound(await api<GiftVoucherDetails>(`${base}/code/${encodeURIComponent(typed)}`));
    } catch (err) {
      const missing =
        err instanceof ApiError && (err.code === 'NOT_FOUND' || err.code === 'VALIDATION_ERROR');
      setError(missing ? t.vouchers.notFound : errorText(t, err));
    } finally {
      unlock();
    }
  }

  return (
    <section className="section" aria-label={t.vouchers.checkTitle}>
      <h2>{t.vouchers.checkTitle}</h2>
      <form className="row" onSubmit={(e) => void check(e)}>
        <label className="field grow">
          <span>{t.vouchers.code}</span>
          <input
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={20}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <button className="btn" disabled={busy} style={{ alignSelf: 'flex-end' }}>
          {t.vouchers.check}
        </button>
      </form>
      <ErrorBox>{error}</ErrorBox>
      {found ? <VoucherDetails details={found} onChange={onFound} /> : null}
    </section>
  );
}

/** Task 491: "Nowy bon" — owners and managers. */
function NewVoucher({ onSold }: { onSold: (voucher: GiftVoucher) => void }) {
  const { t } = useI18n();
  const { orgId, location } = useSession();
  const base = `/v1/organizations/${orgId}/locations/${location.id}/gift-vouchers`;
  const [amount, setAmount] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [recipient, setRecipient] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [sold, setSold] = useState<GiftVoucher | null>(null);
  const { busy, lock, unlock } = useSubmitLock();

  async function sell(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSold(null);
    const grosze = parseAmount(amount);
    if (!grosze || grosze < 100) return setError(t.vouchers.wrongAmount);
    if (!lock()) return;
    try {
      const voucher = await api<GiftVoucher>(base, {
        method: 'POST',
        body: {
          amountGrosze: grosze,
          validUntil: validUntil || null,
          recipient: recipient.trim() || null,
          note: note.trim() || null,
        },
      });
      setSold(voucher);
      setAmount('');
      setValidUntil('');
      setRecipient('');
      setNote('');
      onSold(voucher);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      unlock();
    }
  }

  return (
    <section className="section" aria-label={t.vouchers.newTitle}>
      <h2>{t.vouchers.newTitle}</h2>
      <form className="form" onSubmit={(e) => void sell(e)}>
        <ErrorBox>{error}</ErrorBox>
        <div className="row">
          <label className="field grow">
            <span>{t.vouchers.amount}</span>
            <input
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="field grow">
            <span>
              {t.vouchers.validUntilField} ({t.common.optional})
            </span>
            <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <label className="field grow">
            <span>
              {t.vouchers.recipient} ({t.common.optional})
            </span>
            <input
              maxLength={80}
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
          </label>
          <label className="field grow">
            <span>
              {t.vouchers.note} ({t.common.optional})
            </span>
            <input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <button className="btn" disabled={busy}>
          {t.vouchers.sell}
        </button>
      </form>
      {sold ? (
        <p className="note" role="status">
          {fill(t.vouchers.sold, { code: sold.code })}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Task 491: "Bony podarunkowe" in the cabinet. Everyone in the salon checks a voucher by its code
 * and takes a payment with it; owners and managers also sell vouchers, see the ones sold (with
 * what is left on the valid ones) and cancel one sold by mistake. The server checks the rights.
 */
export default function VouchersPage() {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const { orgId, location, role } = useSession();
  const manager = role !== 'staff';
  const base = `/v1/organizations/${orgId}/locations/${location.id}/gift-vouchers`;
  const money = (n: number) => formatPrice(n, location.currency, tag);
  const [list, setList] = useState<GiftVoucherList | null>(null);
  const [found, setFound] = useState<GiftVoucherDetails | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const { busy, lock, unlock } = useSubmitLock();

  const load = useCallback(async () => {
    if (!manager) return;
    try {
      setList(await api<GiftVoucherList>(base));
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [base, manager, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const [exporting, setExporting] = useState(false);

  /** Task 494: "CSV bonów" — every voucher for the accountant (column names in the cabinet language). */
  async function exportCsv(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    setError('');
    try {
      const lang = (['pl', 'uk', 'ru', 'en'] as const).find((l) => l === locale) ?? 'pl';
      const res = await apiResponse(`${base}/export.csv`, { query: { locale: lang } });
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'bony.csv';
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await res.blob());
      link.download = name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setExporting(false);
    }
  }

  /** A payment changes what is left: the list shows it too. */
  function onFound(details: GiftVoucherDetails | null) {
    setFound(details);
    if (details) void load();
  }

  async function show(voucher: GiftVoucher) {
    setError('');
    try {
      setFound(await api<GiftVoucherDetails>(`${base}/${voucher.id}`));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  async function cancel(voucher: GiftVoucher) {
    if (!lock()) return;
    setError('');
    setInfo('');
    try {
      await api<GiftVoucher>(`${base}/${voucher.id}/cancel`, { method: 'POST' });
      setInfo(fill(t.vouchers.cancelled, { code: voucher.code }));
      if (found?.voucher.id === voucher.id) {
        setFound(await api<GiftVoucherDetails>(`${base}/${voucher.id}`));
      }
      await load();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setConfirm(null);
      unlock();
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>{t.vouchers.title}</h1>
      </div>
      <div className="page">
        <p className="small muted">{t.vouchers.hint}</p>
        <CheckVoucher found={found} onFound={onFound} />
        {manager ? (
          <>
            <NewVoucher onSold={() => void load()} />
            <section className="section" aria-label={t.vouchers.listTitle}>
              <h2>{t.vouchers.listTitle}</h2>
              <ErrorBox>{error}</ErrorBox>
              {info ? (
                <p className="note" role="status">
                  {info}
                </p>
              ) : null}
              {list === null ? (
                error ? null : (
                  <Spinner />
                )
              ) : list.vouchers.length === 0 ? (
                <p className="note">{t.vouchers.empty}</p>
              ) : (
                <>
                  <div className="row">
                    <p className="small grow">
                      {fill(t.vouchers.activeTotal, { amount: money(list.activeBalanceGrosze) })}
                    </p>
                    <button
                      type="button"
                      className="btn btn--quiet btn--small"
                      disabled={exporting}
                      onClick={() => void exportCsv()}
                    >
                      {t.vouchers.csv}
                    </button>
                  </div>
                  <ul className="list">
                    {list.vouchers.map((v) => (
                      <li key={v.id} className="list-row">
                        <span className="grow">
                          <VoucherSummary voucher={v} />
                          <span className="small muted">
                            {fill(t.vouchers.soldOn, { date: formatDay(v.soldDate, tag) })}
                            {v.soldByName
                              ? ` ${fill(t.vouchers.soldBy, { name: v.soldByName })}`
                              : ''}
                          </span>
                        </span>
                        {confirm === v.id ? (
                          <span
                            className="row"
                            role="group"
                            aria-label={fill(t.vouchers.cancelAsk, { code: v.code })}
                          >
                            <span className="small">
                              {fill(t.vouchers.cancelAsk, { code: v.code })}
                            </span>
                            <button
                              type="button"
                              className="btn btn--danger btn--small"
                              disabled={busy}
                              onClick={() => void cancel(v)}
                            >
                              {t.vouchers.cancelYes}
                            </button>
                            <button
                              type="button"
                              className="btn btn--quiet btn--small"
                              onClick={() => setConfirm(null)}
                            >
                              {t.vouchers.cancelNo}
                            </button>
                          </span>
                        ) : (
                          <span className="row">
                            <button
                              type="button"
                              className="link-btn small"
                              aria-label={`${t.vouchers.show} ${v.code}`}
                              onClick={() => void show(v)}
                            >
                              {t.vouchers.show}
                            </button>
                            {v.status === 'active' ? (
                              <button
                                type="button"
                                className="link-btn small"
                                aria-label={`${t.vouchers.cancel} ${v.code}`}
                                onClick={() => {
                                  setInfo('');
                                  setConfirm(v.id);
                                }}
                              >
                                {t.vouchers.cancel}
                              </button>
                            ) : null}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          </>
        ) : null}
      </div>
    </>
  );
}
