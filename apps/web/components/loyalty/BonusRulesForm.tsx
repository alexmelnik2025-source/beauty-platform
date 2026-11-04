'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ErrorBox } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';
import type { LoyaltyBonusRules, Staff } from '@/lib/types';

interface Row {
  name: string;
  staffIds: string[];
  weekdays: number[];
  multiplier: string;
  extraPoints: string;
}

const toRow = (r: LoyaltyBonusRules['rules'][number]): Row => ({
  name: r.name,
  staffIds: r.staff.map((s) => s.id),
  weekdays: r.weekdays,
  multiplier: String(r.multiplier),
  extraPoints: String(r.extraPoints),
});

const toggle = <T,>(list: T[], value: T, on: boolean): T[] =>
  on ? [...list, value] : list.filter((v) => v !== value);

/**
 * "Dodatkowe pieczątki i punkty" (task 19): ×N or +N for a paid visit at chosen specialists
 * and/or on chosen weekdays — e.g. to fill quiet Monday–Wednesday at one barber.
 * The server picks the best matching rule for each visit; saved as a whole list.
 */
export function BonusRulesForm({ org, base }: { org: string; base: string }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [staff, setStaff] = useState<{ id: string; displayName: string }[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api<LoyaltyBonusRules>(`${org}/loyalty/bonus-rules`),
      api<Staff[]>(`${base}/staff`),
    ])
      .then(([data, team]) => {
        setRows(data.rules.map(toRow));
        // Specialists of this location, plus any of other locations already named in a rule.
        const known = new Map(team.map((s) => [s.id, s.displayName]));
        for (const rule of data.rules) {
          for (const s of rule.staff) if (!known.has(s.id)) known.set(s.id, s.displayName);
        }
        setStaff([...known].map(([id, displayName]) => ({ id, displayName })));
      })
      .catch((err) => setError(errorText(t, err)));
  }, [org, base, t]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await api<LoyaltyBonusRules>(`${org}/loyalty/bonus-rules`, {
        method: 'PUT',
        body: {
          rules: rows.map((r) => ({
            name: r.name,
            staffIds: r.staffIds,
            weekdays: r.weekdays,
            multiplier: Number(r.multiplier || 1),
            extraPoints: Number(r.extraPoints || 0),
          })),
        },
      });
      setRows(saved.rules.map(toRow));
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
    <form className="section form" onSubmit={save} aria-labelledby="loyalty-bonus-rules">
      <h2 id="loyalty-bonus-rules">{t.loyalty.bonusRules}</h2>
      <p className="small muted">{t.loyalty.bonusRulesHint}</p>
      <ErrorBox>{error}</ErrorBox>
      {message ? (
        <p className="note" role="status">
          {message}
        </p>
      ) : null}
      {rows.length === 0 ? <p className="note">{t.loyalty.bonusNone}</p> : null}
      <ul className="list" aria-label={t.loyalty.bonusRules}>
        {rows.map((r, i) => (
          <li
            key={i}
            className="list-row"
            style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}
          >
            <label className="field grow">
              <span>{t.loyalty.bonusName}</span>
              <input
                required
                maxLength={60}
                value={r.name}
                onChange={(e) => set(i, { name: e.target.value })}
              />
            </label>
            <label className="field" style={{ width: 100 }}>
              <span>{t.loyalty.bonusMultiplier}</span>
              <input
                type="number"
                min={1}
                max={10}
                required
                value={r.multiplier}
                onChange={(e) => set(i, { multiplier: e.target.value })}
              />
            </label>
            <label className="field" style={{ width: 100 }}>
              <span>{t.loyalty.bonusExtra}</span>
              <input
                type="number"
                min={0}
                max={100000}
                value={r.extraPoints}
                onChange={(e) => set(i, { extraPoints: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="btn btn--quiet btn--small"
              aria-label={`${t.loyalty.bonusRemove}: ${r.name}`}
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              ✕
            </button>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0, width: '100%' }}>
              <legend>{t.loyalty.bonusStaff}</legend>
              <div className="list-pick">
                {staff.map((s) => (
                  <label key={s.id} className="check">
                    <input
                      type="checkbox"
                      checked={r.staffIds.includes(s.id)}
                      onChange={(e) =>
                        set(i, { staffIds: toggle(r.staffIds, s.id, e.target.checked) })
                      }
                    />
                    <span>{s.displayName}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0, width: '100%' }}>
              <legend>{t.loyalty.bonusDays}</legend>
              <div className="list-pick">
                {t.weekdays.map((day, d) => (
                  <label key={day} className="check">
                    <input
                      type="checkbox"
                      checked={r.weekdays.includes(d + 1)}
                      onChange={(e) =>
                        set(i, {
                          weekdays: toggle(r.weekdays, d + 1, e.target.checked).sort(
                            (a, b) => a - b,
                          ),
                        })
                      }
                    />
                    <span>{day}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </li>
        ))}
      </ul>
      <div className="row">
        {rows.length < 20 ? (
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() =>
              setRows([
                ...rows,
                { name: '', staffIds: [], weekdays: [], multiplier: '2', extraPoints: '0' },
              ])
            }
          >
            {t.loyalty.bonusAdd}
          </button>
        ) : null}
        <button className="btn" disabled={busy}>
          {t.loyalty.bonusSave}
        </button>
      </div>
    </form>
  );
}
