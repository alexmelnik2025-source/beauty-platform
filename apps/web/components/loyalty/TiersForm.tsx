'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ErrorBox, FieldError } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';
import type { LoyaltyTiers } from '@/lib/types';

interface Row {
  name: string;
  threshold: string;
  discountPercent: string;
}

const toRow = (t: LoyaltyTiers['tiers'][number], spend: boolean): Row => ({
  name: t.name,
  threshold: String(spend ? t.threshold / 100 : t.threshold),
  discountPercent: String(t.discountPercent),
});

/** Task 697: the fields of a row, in their order on screen. */
const FIELDS = ['name', 'threshold', 'discountPercent'] as const;
/** An amount with at most two decimals ("1500" or "1500.50", the comma already a dot). */
const AMOUNT = /^\d+(\.\d{1,2})?$/;
/** A whole number typed in the allowed range. */
const wholeIn = (text: string, min: number, max: number) =>
  /^\d+$/.test(text.trim()) && Number(text) >= min && Number(text) <= max;

/** Task 664: a field of the tiers form — "periodDays", or "<row>.name" / "<row>.threshold" / … */
type FieldKey = string;

/**
 * Task 664 (owner's rule: errors at the field): the fields the server's answer is about —
 * "tiers.1.name" becomes "1.name"; an answer about the whole list stays a line above the form.
 */
function serverFields(err: unknown): FieldKey[] {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return [];
  if (!Array.isArray(err.details)) return [];
  return (err.details as { path?: string }[])
    .map((d) => d.path ?? '')
    .map((path) => (path.startsWith('tiers.') ? path.slice('tiers.'.length) : path))
    .filter((key) => key === 'periodDays' || /^\d+\.(name|threshold|discountPercent)$/.test(key));
}

/** The props that tie a field to the error shown under it, for screen readers. */
function invalidProps(id: string, text: string | undefined) {
  return {
    'aria-invalid': text ? true : undefined,
    'aria-describedby': text ? id : undefined,
  } as const;
}

/**
 * "Poziomy klientów" (task 10e): the salon's own tiers — name, threshold in paid visits or in
 * the amount paid over the last N days, and the tier's discount. Saved as a whole list.
 */
export function TiersForm({ org, currency }: { org: string; currency: string }) {
  const { t } = useI18n();
  const [basis, setBasis] = useState<LoyaltyTiers['basis']>('visits');
  const [periodDays, setPeriodDays] = useState('365');
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState('');
  /**
   * Task 810 (owner's rule: errors where the action is): a refused save is said under
   * "Zapisz poziomy" at the bottom of the form, not at its top; the typed tiers stay.
   */
  const [saveError, setSaveError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  /** Task 664: what is wrong, by field — said under the field, gone when it is changed. */
  const [fieldErrors, setFieldErrors] = useState<Record<FieldKey, string>>({});
  const spend = basis === 'spend';

  useEffect(() => {
    api<LoyaltyTiers>(`${org}/loyalty/tiers`)
      .then((data) => {
        setBasis(data.basis);
        setPeriodDays(String(data.periodDays));
        setRows(data.tiers.map((tier) => toRow(tier, data.basis === 'spend')));
      })
      .catch((err) => setError(errorText(t, err)));
  }, [org, t]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSaveError('');
    setMessage('');
    // Task 664: a name of spaces only, or a threshold another tier already has — said at once.
    const local: Record<FieldKey, string> = {};
    const seen = new Set<string>();
    // Task 697: what the browser checked with its bubble — an empty field, a number out of
    // range, a fraction or a wrong amount — is said under the field too.
    const range = (min: number, max: number) =>
      fill(t.guard.numberRange, { min: String(min), max: String(max) });
    if (!wholeIn(periodDays, 30, 1095)) {
      local.periodDays = periodDays.trim() ? range(30, 1095) : t.onboarding.fieldRequired;
    }
    rows.forEach((r, i) => {
      if (!r.name.trim()) local[`${i}.name`] = t.onboarding.fieldRequired;
      const threshold = r.threshold.trim().replace(',', '.');
      if (threshold === '') local[`${i}.threshold`] = t.onboarding.fieldRequired;
      else if (spend ? !AMOUNT.test(threshold) || Number(threshold) > 1_000_000 : false) {
        local[`${i}.threshold`] = t.calendar.tillInvalid;
      } else if (!spend && !wholeIn(threshold, 0, 100_000_000)) {
        local[`${i}.threshold`] = range(0, 100_000_000);
      } else if (seen.has(String(Number(threshold)))) {
        local[`${i}.threshold`] = t.loyalty.tierThresholdTaken;
      }
      seen.add(String(Number(threshold)));
      if (r.discountPercent.trim() && !wholeIn(r.discountPercent, 0, 100)) {
        local[`${i}.discountPercent`] = range(0, 100);
      }
    });
    setFieldErrors(local);
    // The cursor goes to the first field on screen: the period, then the rows in order.
    const order = ['periodDays', ...rows.flatMap((_, i) => FIELDS.map((f) => `${i}.${f}`))];
    const first = order.find((key) => local[key]);
    if (first) {
      document
        .getElementById(first === 'periodDays' ? 'tier-period' : `tier-${first.replace('.', '-')}`)
        ?.focus();
      return;
    }
    setBusy(true);
    try {
      const saved = await api<LoyaltyTiers>(`${org}/loyalty/tiers`, {
        method: 'PUT',
        body: {
          basis,
          periodDays: Number(periodDays),
          tiers: rows.map((r) => ({
            name: r.name,
            threshold: spend
              ? Math.round(Number(r.threshold.replace(',', '.')) * 100)
              : Number(r.threshold),
            discountPercent: Number(r.discountPercent || 0),
          })),
        },
      });
      setRows(saved.tiers.map((tier) => toRow(tier, saved.basis === 'spend')));
      setMessage(t.actions.saved);
    } catch (err) {
      const keys = serverFields(err);
      if (keys.length > 0) {
        setFieldErrors(
          Object.fromEntries(
            keys.map((key) => [
              key,
              key.endsWith('.name') ? t.onboarding.fieldRequired : errorText(t, err),
            ]),
          ),
        );
      } else {
        setSaveError(errorText(t, err));
      }
    } finally {
      setBusy(false);
    }
  }

  const set = (index: number, change: Partial<Row>) => {
    setRows(rows.map((r, i) => (i === index ? { ...r, ...change } : r)));
    clear(...Object.keys(change).map((field) => `${index}.${field}`));
  };
  /** Task 664: a changed field drops its error. */
  const clear = (...keys: FieldKey[]) => {
    setSaveError('');
    if (!keys.some((key) => fieldErrors[key])) return;
    setFieldErrors((errors) =>
      Object.fromEntries(Object.entries(errors).filter(([key]) => !keys.includes(key))),
    );
  };
  /** The error under one field of a row, and its id. */
  const rowError = (i: number, field: keyof Row) => fieldErrors[`${i}.${field}`];
  const rowErrorId = (i: number, field: keyof Row) => `tier-${i}-${field}-error`;

  return (
    <form noValidate className="section form" onSubmit={save} aria-labelledby="loyalty-tiers">
      <h2 id="loyalty-tiers">{t.loyalty.tiers}</h2>
      <p className="small muted">{t.loyalty.tiersHint}</p>
      <ErrorBox>{error}</ErrorBox>
      {message ? (
        <p className="note" role="status">
          {message}
        </p>
      ) : null}
      <div className="row">
        <label className="field">
          <span>{t.loyalty.tierBasis}</span>
          <select value={basis} onChange={(e) => setBasis(e.target.value as LoyaltyTiers['basis'])}>
            <option value="visits">{t.loyalty.tierBasisVisits}</option>
            <option value="spend">{t.loyalty.tierBasisSpend}</option>
          </select>
        </label>
        <label className="field">
          <span>{t.loyalty.tierPeriod}</span>
          <input
            type="number"
            min={30}
            max={1095}
            required
            id="tier-period"
            value={periodDays}
            {...invalidProps('tier-period-error', fieldErrors.periodDays)}
            onChange={(e) => {
              setPeriodDays(e.target.value);
              clear('periodDays');
            }}
          />
          <FieldError id="tier-period-error" text={fieldErrors.periodDays} />
        </label>
      </div>
      {rows.length === 0 ? <p className="note">{t.loyalty.tierNone}</p> : null}
      <ul className="list" aria-label={t.loyalty.tiers}>
        {rows.map((r, i) => (
          <li key={i} className="list-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <label className="field grow">
              <span>{t.loyalty.tierName}</span>
              <input
                id={`tier-${i}-name`}
                required
                maxLength={40}
                value={r.name}
                {...invalidProps(rowErrorId(i, 'name'), rowError(i, 'name'))}
                onChange={(e) => set(i, { name: e.target.value })}
              />
              <FieldError id={rowErrorId(i, 'name')} text={rowError(i, 'name')} />
            </label>
            <label className="field" style={{ width: 120 }}>
              <span>
                {spend
                  ? fill(t.loyalty.tierThresholdSpend, { currency })
                  : t.loyalty.tierThresholdVisits}
              </span>
              <input
                type="number"
                min={0}
                step={spend ? '0.01' : 1}
                required
                id={`tier-${i}-threshold`}
                value={r.threshold}
                {...invalidProps(rowErrorId(i, 'threshold'), rowError(i, 'threshold'))}
                onChange={(e) => set(i, { threshold: e.target.value })}
              />
              <FieldError id={rowErrorId(i, 'threshold')} text={rowError(i, 'threshold')} />
            </label>
            <label className="field" style={{ width: 100 }}>
              <span>{t.loyalty.tierDiscount}</span>
              <input
                type="number"
                min={0}
                max={100}
                id={`tier-${i}-discountPercent`}
                value={r.discountPercent}
                {...invalidProps(rowErrorId(i, 'discountPercent'), rowError(i, 'discountPercent'))}
                onChange={(e) => set(i, { discountPercent: e.target.value })}
              />
              <FieldError
                id={rowErrorId(i, 'discountPercent')}
                text={rowError(i, 'discountPercent')}
              />
            </label>
            <button
              type="button"
              className="btn btn--quiet btn--small"
              aria-label={`${t.loyalty.tierRemove}: ${r.name}`}
              onClick={() => {
                setRows(rows.filter((_, j) => j !== i));
                // The rows below move up: their errors would point at the wrong row.
                setFieldErrors({});
              }}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        {rows.length < 8 ? (
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => setRows([...rows, { name: '', threshold: '', discountPercent: '0' }])}
          >
            {t.loyalty.tierAdd}
          </button>
        ) : null}
        <button
          className="btn"
          disabled={busy}
          aria-describedby={saveError ? 'tier-save-error' : undefined}
        >
          {t.loyalty.tierSave}
        </button>
      </div>
      <FieldError id="tier-save-error" text={saveError} />
    </form>
  );
}
