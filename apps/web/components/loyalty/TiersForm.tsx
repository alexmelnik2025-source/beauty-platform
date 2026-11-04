'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ErrorBox } from '@/components/ui';
import { api } from '@/lib/api';
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
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
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
    setBusy(true);
    setError('');
    setMessage('');
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
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  const set = (index: number, change: Partial<Row>) =>
    setRows(rows.map((r, i) => (i === index ? { ...r, ...change } : r)));

  return (
    <form className="section form" onSubmit={save} aria-labelledby="loyalty-tiers">
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
            value={periodDays}
            onChange={(e) => setPeriodDays(e.target.value)}
          />
        </label>
      </div>
      {rows.length === 0 ? <p className="note">{t.loyalty.tierNone}</p> : null}
      <ul className="list" aria-label={t.loyalty.tiers}>
        {rows.map((r, i) => (
          <li key={i} className="list-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <label className="field grow">
              <span>{t.loyalty.tierName}</span>
              <input
                required
                maxLength={40}
                value={r.name}
                onChange={(e) => set(i, { name: e.target.value })}
              />
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
                value={r.threshold}
                onChange={(e) => set(i, { threshold: e.target.value })}
              />
            </label>
            <label className="field" style={{ width: 100 }}>
              <span>{t.loyalty.tierDiscount}</span>
              <input
                type="number"
                min={0}
                max={100}
                value={r.discountPercent}
                onChange={(e) => set(i, { discountPercent: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="btn btn--quiet btn--small"
              aria-label={`${t.loyalty.tierRemove}: ${r.name}`}
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
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
        <button className="btn" disabled={busy}>
          {t.loyalty.tierSave}
        </button>
      </div>
    </form>
  );
}
