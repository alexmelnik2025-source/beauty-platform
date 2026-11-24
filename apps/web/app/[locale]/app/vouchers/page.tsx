'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { parseTip as parseAmount } from '@/components/calendar/TipField';
import { useSession } from '@/components/Session';
import { ErrorBox, FieldError, Spinner } from '@/components/ui';
import { api, ApiError, apiResponse } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import type { Dict } from '@/lib/i18n/pl';
import { encodeQr, qrSvg } from '@/lib/qr';
import { formatDay, formatPrice } from '@/lib/time';
import {
  PAYMENT_METHODS,
  type GiftVoucher,
  type GiftVoucherDetails,
  type GiftVoucherList,
  type PaymentMethod,
} from '@/lib/types';
import { useSubmitLock } from '@/lib/submit-lock';

/**
 * Task 662 (owner's rule: errors at the field): which field of a voucher form the server's answer
 * is about — the amount, the "valid until" date, or none (then it stays a line above the form).
 */
/**
 * Task 704: a half-typed date ("12.__.2026") reads as empty — it would quietly clear "Ważny do".
 * True when the date field holds such a date, so it is said under the field instead.
 */
function dateIncomplete(id: string): boolean {
  const input = document.getElementById(id);
  return input instanceof HTMLInputElement && input.validity.badInput;
}

function voucherFieldOf(err: unknown): 'amount' | 'validUntil' | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'VOUCHER_BALANCE') return 'amount';
  if (err.code === 'VOUCHER_DATE_PAST') return 'validUntil';
  if (err.code !== 'VALIDATION_ERROR' || !Array.isArray(err.details)) return null;
  const paths = (err.details as { path?: string }[]).map((d) => d.path);
  if (paths.includes('amountGrosze')) return 'amount';
  if (paths.includes('validUntil')) return 'validUntil';
  return null;
}

/** The props that tie a field to the error shown under it, for screen readers. */
function invalidProps(id: string, text: string) {
  return {
    'aria-invalid': text ? true : undefined,
    'aria-describedby': text ? id : undefined,
  } as const;
}

const STATUS: Record<GiftVoucher['status'], keyof Dict['vouchers']> = {
  active: 'statusActive',
  used: 'statusUsed',
  expired: 'statusExpired',
  cancelled: 'statusCancelled',
};

/** Tasks 547, 550: "Jak klient zapłacił za bon" — Gotówka / Karta / … or not given. */
function PaymentSelect({
  value,
  onChange,
}: {
  value: PaymentMethod | '';
  onChange: (value: PaymentMethod | '') => void;
}) {
  const { t } = useI18n();
  return (
    <label className="field">
      <span>{t.vouchers.paymentLabel}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as PaymentMethod | '')}>
        <option value="">{t.vouchers.paymentUnknown}</option>
        {PAYMENT_METHODS.map((method) => (
          <option key={method} value={method}>
            {t.appointment.paymentMethods[method]}
          </option>
        ))}
      </select>
      <span className="small muted">{t.vouchers.paymentHint}</span>
    </label>
  );
}

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

/** Task 501: a voucher that may be used now and ends by `until` (30 days from the salon's today). */
const endsSoon = (voucher: GiftVoucher, until: string) =>
  voucher.status === 'active' && voucher.validUntil !== null && voucher.validUntil <= until;

type Filter = 'all' | 'soon' | GiftVoucher['status'];

/** Task 502: what the list shows — by status (or "ending soon") and by code or for whom. */
function filterVouchers(
  vouchers: GiftVoucher[],
  filter: Filter,
  search: string,
  until: string,
): GiftVoucher[] {
  const typed = search.trim().toLowerCase();
  const code = typed.toUpperCase().replace(/[\s-]/g, '');
  return vouchers.filter((v) => {
    if (filter === 'soon' ? !endsSoon(v, until) : filter !== 'all' && v.status !== filter) {
      return false;
    }
    if (!typed) return true;
    return (
      (code !== '' && v.code.includes(code)) || (v.recipient ?? '').toLowerCase().includes(typed)
    );
  });
}

/** "ABCD-EFGH": easier to read off paper; the dash does not matter when the code is checked. */
const printedCode = (code: string) =>
  code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

/**
 * Task 496: "Drukuj bon" — the voucher as a card to hand to the client: the salon, the amount, for
 * whom, the code and the last day. Only the card is printed (`html.print-voucher` in globals.css).
 * Task 539: while the salon page is public, a QR code on the card opens it with the code filled in
 * (`/b/<salon>?bon=<code>`) — the client sees what is left without asking the salon.
 */
function VoucherPrint({ voucher }: { voucher: GiftVoucher }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const { location } = useSession();
  // The card is on the page only while it is printed (its words would repeat the summary's).
  const [printing, setPrinting] = useState(false);
  const checkSvg = useMemo(() => {
    if (!printing || !location.onlineBookingEnabled) return '';
    const url = `${window.location.origin}/${location.defaultLocale}/b/${location.slug}?bon=${voucher.code}`;
    return qrSvg(encodeQr(url), t.vouchers.printCheck);
  }, [printing, location, voucher.code, t.vouchers.printCheck]);
  useEffect(() => {
    const done = () => {
      document.documentElement.classList.remove('print-voucher');
      setPrinting(false);
    };
    window.addEventListener('afterprint', done);
    return () => window.removeEventListener('afterprint', done);
  }, []);
  useEffect(() => {
    if (!printing) return;
    document.documentElement.classList.add('print-voucher');
    window.print();
  }, [printing]);
  return (
    <>
      {printing ? (
        <div className="voucher-print" data-testid="voucher-print">
          <strong className="voucher-print__salon">{location.name}</strong>
          <span className="voucher-print__title">{t.vouchers.printTitle}</span>
          <span className="voucher-print__amount">
            {formatPrice(voucher.amountGrosze, location.currency, tag)}
          </span>
          {voucher.recipient ? (
            <span>{fill(t.vouchers.forWhom, { name: voucher.recipient })}</span>
          ) : null}
          <span className="voucher-print__code">{printedCode(voucher.code)}</span>
          <small>
            {voucher.validUntil
              ? fill(t.vouchers.validUntil, { date: formatDay(voucher.validUntil, tag) })
              : t.vouchers.noEnd}
          </small>
          {checkSvg ? (
            <div className="voucher-print__check">
              {/* The SVG carries its own name (<title>). */}
              <div dangerouslySetInnerHTML={{ __html: checkSvg }} />
              <small>{t.vouchers.printCheck}</small>
            </div>
          ) : null}
        </div>
      ) : null}
      <button type="button" className="btn btn--quiet btn--small" onClick={() => setPrinting(true)}>
        {t.vouchers.print}
      </button>
    </>
  );
}

/**
 * Task 499: "Zmień bon" — owners and managers move the last day (also to give an expired voucher
 * more time), fix who it is for and the note. Not the amount; the server checks the rights.
 */
function EditVoucher({
  voucher,
  onSaved,
}: {
  voucher: GiftVoucher;
  onSaved: (voucher: GiftVoucher) => void;
}) {
  const { t } = useI18n();
  const { orgId, location } = useSession();
  const base = `/v1/organizations/${orgId}/locations/${location.id}/gift-vouchers`;
  const [open, setOpen] = useState(false);
  const [validUntil, setValidUntil] = useState(voucher.validUntil ?? '');
  const [recipient, setRecipient] = useState(voucher.recipient ?? '');
  const [note, setNote] = useState(voucher.note ?? '');
  const [payment, setPayment] = useState<PaymentMethod | ''>(voucher.paymentMethod ?? '');
  const [error, setError] = useState('');
  /** Task 662: a past "valid until" — said under the date. */
  const [dateError, setDateError] = useState('');
  const { busy, lock, unlock } = useSubmitLock();

  // The form takes the place of "Edytuj": the cursor goes to its first field, and back to
  // "Edytuj" when the form closes (saved or cancelled), for keyboard and screen reader users.
  const editRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) editRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  function start() {
    setValidUntil(voucher.validUntil ?? '');
    setRecipient(voucher.recipient ?? '');
    setNote(voucher.note ?? '');
    setPayment(voucher.paymentMethod ?? '');
    setError('');
    setDateError('');
    setOpen(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    setDateError('');
    const dateId = `voucher-edit-date-${voucher.id}`;
    if (dateIncomplete(dateId)) {
      setDateError(t.vouchers.dateIncomplete);
      document.getElementById(dateId)?.focus();
      return;
    }
    if (!lock()) return;
    try {
      const updated = await api<GiftVoucher>(`${base}/${voucher.id}`, {
        method: 'PATCH',
        body: {
          validUntil: validUntil || null,
          recipient: recipient.trim() || null,
          note: note.trim() || null,
          paymentMethod: payment || null,
        },
      });
      setOpen(false);
      onSaved(updated);
    } catch (err) {
      if (voucherFieldOf(err) === 'validUntil') setDateError(errorText(t, err));
      else setError(errorText(t, err));
    } finally {
      unlock();
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn btn--quiet btn--small" onClick={start} ref={editRef}>
        {t.vouchers.edit}
      </button>
    );
  }
  return (
    <form
      noValidate
      className="form"
      aria-label={`${t.vouchers.edit} ${voucher.code}`}
      onSubmit={(e) => void save(e)}
    >
      <h3>{t.vouchers.edit}</h3>
      <p className="small muted">{t.vouchers.editHint}</p>
      <div className="row">
        <label className="field grow">
          <span>{t.vouchers.validUntilField}</span>
          <input
            id={`voucher-edit-date-${voucher.id}`}
            type="date"
            autoFocus
            value={validUntil}
            {...invalidProps(`voucher-edit-date-error-${voucher.id}`, dateError)}
            onChange={(e) => {
              setValidUntil(e.target.value);
              setDateError('');
            }}
          />
          <FieldError id={`voucher-edit-date-error-${voucher.id}`} text={dateError} />
        </label>
        <label className="field grow">
          <span>{t.vouchers.recipient}</span>
          <input maxLength={80} value={recipient} onChange={(e) => setRecipient(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>{t.vouchers.note}</span>
        <input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <PaymentSelect value={payment} onChange={setPayment} />
      <div className="row">
        <button
          className="btn"
          disabled={busy}
          aria-describedby={error ? `voucher-edit-error-${voucher.id}` : undefined}
        >
          {t.common.save}
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => setOpen(false)}>
          {t.common.cancel}
        </button>
      </div>
      {/* Task 777 (owner's rule: errors where the action is): a refused "Zapisz" is said under
          it, not as a box above the fields; what was typed stays. */}
      <FieldError id={`voucher-edit-error-${voucher.id}`} text={error} />
    </form>
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
  const { orgId, location, role } = useSession();
  const base = `/v1/organizations/${orgId}/locations/${location.id}/gift-vouchers`;
  const money = (n: number) => formatPrice(n, location.currency, tag);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  /**
   * Task 732 (owner's rule: errors where the action is): a refused "Zapłać bonem" that is not about
   * the amount is said under that button, not as a line at the top of the card.
   */
  const [payError, setPayError] = useState('');
  /** Task 662: a wrong amount or one above what is left — said under "Kwota do zapłaty bonem". */
  const [amountError, setAmountError] = useState('');
  /** Task 732: a refused "Tak, cofnij" is said under that payment's row. */
  const [undoError, setUndoError] = useState<{ id: string; text: string } | null>(null);
  const [info, setInfo] = useState('');
  const { busy, lock, unlock } = useSubmitLock();
  const { voucher, uses } = details;
  // Task 531: the payment the owner or a manager is asked about before undoing it.
  const [undoing, setUndoing] = useState<string | null>(null);
  const canUndo = role !== 'staff' && voucher.status !== 'cancelled';

  async function undo(useId: string, amountGrosze: number) {
    setUndoError(null);
    setPayError('');
    setInfo('');
    if (!lock()) return;
    try {
      const next = await api<GiftVoucherDetails>(`${base}/${voucher.id}/uses/${useId}/undo`, {
        method: 'POST',
      });
      onChange(next);
      setUndoing(null);
      setInfo(
        fill(t.vouchers.undone, {
          amount: money(amountGrosze),
          left: money(next.voucher.balanceGrosze),
        }),
      );
    } catch (err) {
      setUndoError({ id: useId, text: errorText(t, err) });
      setUndoing(null);
    } finally {
      unlock();
    }
  }

  async function pay(e: FormEvent) {
    e.preventDefault();
    setPayError('');
    setUndoError(null);
    setAmountError('');
    setInfo('');
    const grosze = parseAmount(amount);
    if (!grosze) return setAmountError(t.vouchers.wrongAmount);
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
      if (voucherFieldOf(err) === 'amount') setAmountError(errorText(t, err));
      else setPayError(errorText(t, err));
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
      {info ? (
        <p className="note" role="status">
          {info}
        </p>
      ) : null}
      {voucher.status === 'active' ? <VoucherPrint voucher={voucher} /> : null}
      {role !== 'staff' && voucher.status !== 'cancelled' ? (
        <EditVoucher
          key={voucher.id}
          voucher={voucher}
          onSaved={(updated) => {
            onChange({ ...details, voucher: updated });
            setInfo(fill(t.vouchers.edited, { code: updated.code }));
          }}
        />
      ) : null}
      {voucher.status === 'active' ? (
        <form noValidate className="form" onSubmit={(e) => void pay(e)}>
          <div className="row">
            <label className="field grow">
              <span>{t.vouchers.payAmount}</span>
              <input
                inputMode="decimal"
                required
                value={amount}
                {...invalidProps(`voucher-pay-amount-error-${voucher.id}`, amountError)}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setAmountError('');
                }}
              />
              <FieldError id={`voucher-pay-amount-error-${voucher.id}`} text={amountError} />
            </label>
            <label className="field grow">
              <span>{t.vouchers.payNote}</span>
              <input maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
          <button
            className="btn"
            disabled={busy}
            aria-describedby={payError ? `voucher-pay-error-${voucher.id}` : undefined}
          >
            {t.vouchers.pay}
          </button>
          <FieldError id={`voucher-pay-error-${voucher.id}`} text={payError} />
        </form>
      ) : null}
      <h3>{t.vouchers.uses}</h3>
      {uses.length === 0 ? (
        <p className="small muted">{t.vouchers.noUses}</p>
      ) : (
        <ul className="list">
          {uses.map((u) => (
            <li
              key={u.id}
              className={`list-row${undoError?.id === u.id ? ' list-row--error' : ''}`}
            >
              <span className="grow">
                {u.undoneDate ? (
                  <s>{money(u.amountGrosze)}</s>
                ) : (
                  <strong>{money(u.amountGrosze)}</strong>
                )}
                <span className="small muted">
                  {formatDay(u.date, tag, { short: true })}, {u.time}
                  {u.byName ? ` · ${u.byName}` : ''}
                  {u.note ? ` · ${u.note}` : ''}
                </span>
                {u.undoneDate ? (
                  <span className="small">
                    {t.vouchers.undoneMark} {formatDay(u.undoneDate, tag, { short: true })}
                    {u.undoneByName ? ` · ${u.undoneByName}` : ''}
                  </span>
                ) : null}
              </span>
              {canUndo && !u.undoneDate ? (
                undoing === u.id ? (
                  <span
                    className="row"
                    role="group"
                    aria-label={fill(t.vouchers.undoAsk, { amount: money(u.amountGrosze) })}
                  >
                    <span className="small">
                      {fill(t.vouchers.undoAsk, { amount: money(u.amountGrosze) })}
                    </span>
                    <button
                      type="button"
                      className="btn btn--danger btn--small"
                      disabled={busy}
                      onClick={() => void undo(u.id, u.amountGrosze)}
                    >
                      {t.vouchers.undoYes}
                    </button>
                    <button
                      type="button"
                      className="btn btn--quiet btn--small"
                      onClick={() => setUndoing(null)}
                    >
                      {t.vouchers.undoNo}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="link-btn small"
                    aria-describedby={
                      undoError?.id === u.id ? `voucher-undo-error-${u.id}` : undefined
                    }
                    onClick={() => {
                      setUndoError(null);
                      setUndoing(u.id);
                    }}
                  >
                    {t.vouchers.undoUse}
                  </button>
                )
              ) : null}
              {undoError?.id === u.id ? (
                <FieldError id={`voucher-undo-error-${u.id}`} text={undoError.text} />
              ) : null}
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
  /** Task 662: no voucher with this code — said under "Kod bonu". */
  const [codeError, setCodeError] = useState('');
  const { busy, lock, unlock } = useSubmitLock();

  async function check(e: FormEvent) {
    e.preventDefault();
    const typed = code.trim();
    // Task 701: "Sprawdź" with an empty code did nothing — now it is said under the field.
    if (!typed) {
      setCodeError(t.onboarding.fieldRequired);
      document.getElementById('voucher-check-code')?.focus();
      return;
    }
    if (!lock()) return;
    setError('');
    setCodeError('');
    onFound(null);
    try {
      onFound(await api<GiftVoucherDetails>(`${base}/code/${encodeURIComponent(typed)}`));
    } catch (err) {
      const missing =
        err instanceof ApiError && (err.code === 'NOT_FOUND' || err.code === 'VALIDATION_ERROR');
      if (missing) setCodeError(t.vouchers.notFound);
      else setError(errorText(t, err));
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
            id="voucher-check-code"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={20}
            value={code}
            {...invalidProps('voucher-check-code-error', codeError)}
            onChange={(e) => {
              setCode(e.target.value);
              setCodeError('');
              setError('');
            }}
          />
        </label>
        <button
          className="btn"
          disabled={busy}
          style={{ alignSelf: 'flex-end' }}
          aria-describedby={error ? 'voucher-check-error' : undefined}
        >
          {t.vouchers.check}
        </button>
      </form>
      {/* Under the row, so "Sprawdź" stays level with the field. Task 777: a refusal that is not
          about the code (no connection, too many tries) is said there too, with its "!". */}
      <FieldError id="voucher-check-code-error" text={codeError} />
      <FieldError id="voucher-check-error" text={error} />
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
  const [payment, setPayment] = useState<PaymentMethod | ''>('');
  const [error, setError] = useState('');
  /** Task 662: a wrong amount and a past "valid until" — said under their fields. */
  const [amountError, setAmountError] = useState('');
  const [dateError, setDateError] = useState('');
  const [sold, setSold] = useState<GiftVoucher | null>(null);
  const { busy, lock, unlock } = useSubmitLock();

  async function sell(e: FormEvent) {
    e.preventDefault();
    setError('');
    setAmountError('');
    setDateError('');
    setSold(null);
    const grosze = parseAmount(amount);
    if (!grosze || grosze < 100) {
      setAmountError(t.vouchers.wrongAmount);
      document.getElementById('voucher-new-amount')?.focus();
      return;
    }
    if (dateIncomplete('voucher-new-date')) {
      setDateError(t.vouchers.dateIncomplete);
      document.getElementById('voucher-new-date')?.focus();
      return;
    }
    if (!lock()) return;
    try {
      const voucher = await api<GiftVoucher>(base, {
        method: 'POST',
        body: {
          amountGrosze: grosze,
          validUntil: validUntil || null,
          recipient: recipient.trim() || null,
          note: note.trim() || null,
          ...(payment ? { paymentMethod: payment } : {}),
        },
      });
      setSold(voucher);
      setAmount('');
      setValidUntil('');
      setRecipient('');
      setNote('');
      setPayment('');
      onSold(voucher);
    } catch (err) {
      const field = voucherFieldOf(err);
      if (field === 'amount') setAmountError(errorText(t, err));
      else if (field === 'validUntil') setDateError(errorText(t, err));
      else setError(errorText(t, err));
    } finally {
      unlock();
    }
  }

  return (
    <section className="section" aria-label={t.vouchers.newTitle}>
      <h2>{t.vouchers.newTitle}</h2>
      <form noValidate className="form" onSubmit={(e) => void sell(e)}>
        <div className="row">
          <label className="field grow">
            <span>{t.vouchers.amount}</span>
            <input
              id="voucher-new-amount"
              inputMode="decimal"
              required
              value={amount}
              {...invalidProps('voucher-new-amount-error', amountError)}
              onChange={(e) => {
                setAmount(e.target.value);
                setAmountError('');
                setError('');
              }}
            />
            <FieldError id="voucher-new-amount-error" text={amountError} />
          </label>
          <label className="field grow">
            <span>
              {t.vouchers.validUntilField} ({t.common.optional})
            </span>
            <input
              id="voucher-new-date"
              type="date"
              value={validUntil}
              {...invalidProps('voucher-new-date-error', dateError)}
              onChange={(e) => {
                setValidUntil(e.target.value);
                setDateError('');
              }}
            />
            <FieldError id="voucher-new-date-error" text={dateError} />
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
        <PaymentSelect value={payment} onChange={setPayment} />
        <button
          className="btn"
          disabled={busy}
          aria-describedby={error ? 'voucher-new-error' : undefined}
        >
          {t.vouchers.sell}
        </button>
        {/* Task 777 (owner's rule: errors where the action is): a refused "Sprzedaj bon" is said
            under it, not as a box above the amount; what was typed stays. */}
        <FieldError id="voucher-new-error" text={error} />
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
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
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

  /**
   * Task 494: "CSV bonów" — every voucher for the accountant (column names in the cabinet language);
   * task 534: "CSV płatności bonami" — every payment taken with them.
   */
  async function exportCsv(file: 'export.csv' | 'uses.csv' = 'export.csv'): Promise<void> {
    if (exporting) return;
    setExporting(true);
    setError('');
    try {
      const lang = (['pl', 'uk', 'ru', 'en'] as const).find((l) => l === locale) ?? 'pl';
      const res = await apiResponse(`${base}/${file}`, { query: { locale: lang } });
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

  const shown = list ? filterVouchers(list.vouchers, filter, search, list.expiringSoon.until) : [];

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
                    <button
                      type="button"
                      className="btn btn--quiet btn--small"
                      disabled={exporting}
                      onClick={() => void exportCsv('uses.csv')}
                    >
                      {t.vouchers.usesCsv}
                    </button>
                  </div>
                  {list.expiringSoon.count > 0 ? (
                    <p className="small" data-testid="vouchers-expiring">
                      {fill(t.vouchers.expiringTotal, {
                        count: String(list.expiringSoon.count),
                        amount: money(list.expiringSoon.balanceGrosze),
                      })}
                    </p>
                  ) : null}
                  <div className="row">
                    <label className="field">
                      <span>{t.vouchers.filter}</span>
                      <select
                        aria-label={t.vouchers.filter}
                        value={filter}
                        onChange={(e) => setFilter(e.target.value as Filter)}
                      >
                        <option value="all">{t.vouchers.filterAll}</option>
                        <option value="active">{t.vouchers.statusActive}</option>
                        <option value="soon">{t.vouchers.filterSoon}</option>
                        <option value="used">{t.vouchers.statusUsed}</option>
                        <option value="expired">{t.vouchers.statusExpired}</option>
                        <option value="cancelled">{t.vouchers.statusCancelled}</option>
                      </select>
                    </label>
                    <label className="field grow">
                      <span>{t.vouchers.search}</span>
                      <input
                        type="search"
                        maxLength={80}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </label>
                  </div>
                  {shown.length === 0 ? <p className="note">{t.vouchers.noMatch}</p> : null}
                  <ul className="list">
                    {shown.map((v) => (
                      <li key={v.id} className="list-row">
                        <span className="grow">
                          <VoucherSummary voucher={v} />
                          {endsSoon(v, list.expiringSoon.until) ? (
                            <span>
                              <span className="chip chip--warn">{t.vouchers.expiringChip}</span>
                            </span>
                          ) : null}
                          <span className="small muted">
                            {fill(t.vouchers.soldOn, { date: formatDay(v.soldDate, tag) })}
                            {v.soldByName
                              ? ` ${fill(t.vouchers.soldBy, { name: v.soldByName })}`
                              : ''}
                            {v.paymentMethod
                              ? ` · ${fill(t.vouchers.paidWith, {
                                  method: t.appointment.paymentMethods[v.paymentMethod],
                                })}`
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
