'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ErrorBox, FieldError } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';
import type { LoyaltyBonusRules, Staff } from '@/lib/types';

interface Row {
  name: string;
  staffIds: string[];
  weekdays: number[];
  multiplier: string;
  extraPoints: string;
  /** '' = any visit. */
  withinDays: string;
}

const toRow = (r: LoyaltyBonusRules['rules'][number]): Row => ({
  name: r.name,
  staffIds: r.staff.map((s) => s.id),
  weekdays: r.weekdays,
  multiplier: String(r.multiplier),
  extraPoints: String(r.extraPoints),
  withinDays: r.withinDays === null ? '' : String(r.withinDays),
});

/** Task 671: a rule's fields that can show an error under them. */
type BonusField = 'name' | 'multiplier' | 'extraPoints' | 'withinDays';
const BONUS_FIELDS: BonusField[] = ['name', 'multiplier', 'extraPoints', 'withinDays'];
/** The allowed whole numbers of each field (the server checks the same). */
const RANGES: Record<Exclude<BonusField, 'name'>, [number, number]> = {
  multiplier: [1, 10],
  extraPoints: [0, 100_000],
  withinDays: [1, 365],
};
/** "row:field" of each wrong field; "row:multiplier!" = the rule gives nothing extra. */
type Problem = `${number}:${BonusField}` | `${number}:multiplier!`;

const wholeIn = (text: string, [min, max]: [number, number]) =>
  /^\d{1,6}$/.test(text.trim()) && Number(text) >= min && Number(text) <= max;

/** Task 671: the wrong fields of the rules, checked before sending as the server would. */
function problemsOf(rows: Row[]): Problem[] {
  return rows.flatMap((r, i) => {
    const out: Problem[] = [];
    if (!r.name.trim()) out.push(`${i}:name`);
    const multiplierOk = wholeIn(r.multiplier || '1', RANGES.multiplier);
    const extraOk = wholeIn(r.extraPoints || '0', RANGES.extraPoints);
    if (!multiplierOk) out.push(`${i}:multiplier`);
    if (!extraOk) out.push(`${i}:extraPoints`);
    if (r.withinDays.trim() !== '' && !wholeIn(r.withinDays, RANGES.withinDays)) {
      out.push(`${i}:withinDays`);
    }
    if (
      multiplierOk &&
      extraOk &&
      Number(r.multiplier || 1) <= 1 &&
      Number(r.extraPoints || 0) <= 0
    ) {
      out.push(`${i}:multiplier!`);
    }
    return out;
  });
}

/** Task 671: the fields of the server's validation answer ("rules.0.name" → "0:name"). */
function serverProblemsOf(err: unknown): Problem[] {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return [];
  if (!Array.isArray(err.details)) return [];
  return (err.details as { path?: string; message?: string }[]).flatMap((d) => {
    const m = /^rules\.(\d+)\.(\w+)/.exec(String(d.path ?? ''));
    if (!m || !BONUS_FIELDS.includes(m[2] as BonusField)) return [];
    const nothing = m[2] === 'multiplier' && /extra/i.test(String(d.message ?? ''));
    return [(nothing ? `${m[1]}:multiplier!` : `${m[1]}:${m[2]}`) as Problem];
  });
}

const toggle = <T,>(list: T[], value: T, on: boolean): T[] =>
  on ? [...list, value] : list.filter((v) => v !== value);

/**
 * "Dodatkowe pieczątki i punkty" (task 19): ×N or +N for a paid visit at chosen specialists
 * and/or on chosen weekdays — e.g. to fill quiet Monday–Wednesday at one barber — and,
 * if the salon wants, only for clients back within N days of their previous paid visit.
 * The server picks the best matching rule for each visit; saved as a whole list.
 */
export function BonusRulesForm({ org, base }: { org: string; base: string }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [staff, setStaff] = useState<{ id: string; displayName: string }[]>([]);
  const [error, setError] = useState('');
  /**
   * Task 813 (owner's rule: errors where the action is): a refused save is said under
   * "Zapisz zasady" (bonus rules) at the bottom of the form, not at its top; the typed rules stay.
   */
  const [saveError, setSaveError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * Task 671 (owner's rule: errors at the field): a blank name, a number out of range or a rule
   * that gives nothing extra is said under its field before sending; the server's answer about a
   * field too. Editing the field takes its error away.
   */
  const [problems, setProblems] = useState<Problem[]>([]);

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
    setMessage('');
    setSaveError('');
    const wrong = problemsOf(rows);
    if (wrong.length > 0) {
      setProblems(wrong);
      const [row, field] = wrong[0]!.replace('!', '').split(':');
      document.getElementById(`bonus-${row}-${field}`)?.focus();
      return;
    }
    setBusy(true);
    setError('');
    setProblems([]);
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
            withinDays: r.withinDays === '' ? null : Number(r.withinDays),
          })),
        },
      });
      setRows(saved.rules.map(toRow));
      setMessage(t.actions.saved);
    } catch (err) {
      const wrong = serverProblemsOf(err);
      setProblems(wrong);
      if (wrong.length === 0) setSaveError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  const set = (index: number, change: Partial<Row>) => {
    setRows(rows.map((r, i) => (i === index ? { ...r, ...change } : r)));
    setSaveError('');
    // Editing a field takes its error away ("nothing extra" goes with either number).
    const touched = Object.keys(change);
    setProblems((list) =>
      list.filter((p) => {
        const [row, field] = p.split(':');
        if (Number(row) !== index) return true;
        if (field === 'multiplier!') {
          return !touched.includes('multiplier') && !touched.includes('extraPoints');
        }
        return !touched.includes(field!);
      }),
    );
  };
  const problem = (i: number, field: BonusField): string | undefined => {
    if (problems.includes(`${i}:${field}`)) {
      if (field === 'name') return t.onboarding.fieldRequired;
      const [min, max] = RANGES[field];
      return fill(t.guard.numberRange, { min: String(min), max: String(max) });
    }
    if (field === 'multiplier' && problems.includes(`${i}:multiplier!`)) {
      return t.loyalty.bonusNothingExtra;
    }
    return undefined;
  };
  const invalid = (i: number, field: BonusField) => {
    const text = problem(i, field);
    return {
      id: `bonus-${i}-${field}`,
      'aria-invalid': text ? true : undefined,
      'aria-describedby': text ? `bonus-${i}-${field}-error` : undefined,
    };
  };
  const fieldError = (i: number, field: BonusField) => (
    <FieldError id={`bonus-${i}-${field}-error`} text={problem(i, field)} />
  );

  return (
    <form className="section form" onSubmit={save} noValidate aria-labelledby="loyalty-bonus-rules">
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
                {...invalid(i, 'name')}
                onChange={(e) => set(i, { name: e.target.value })}
              />
              {fieldError(i, 'name')}
            </label>
            <label className="field" style={{ width: 100 }}>
              <span>{t.loyalty.bonusMultiplier}</span>
              <input
                type="number"
                min={1}
                max={10}
                required
                value={r.multiplier}
                {...invalid(i, 'multiplier')}
                onChange={(e) => set(i, { multiplier: e.target.value })}
              />
              {fieldError(i, 'multiplier')}
            </label>
            <label className="field" style={{ width: 100 }}>
              <span>{t.loyalty.bonusExtra}</span>
              <input
                type="number"
                min={0}
                max={100000}
                value={r.extraPoints}
                {...invalid(i, 'extraPoints')}
                onChange={(e) => set(i, { extraPoints: e.target.value })}
              />
              {fieldError(i, 'extraPoints')}
            </label>
            <label className="field" style={{ width: 150 }}>
              <span>{t.loyalty.bonusWithin}</span>
              <input
                type="number"
                min={1}
                max={365}
                placeholder={t.loyalty.bonusWithinAny}
                value={r.withinDays}
                {...invalid(i, 'withinDays')}
                onChange={(e) => set(i, { withinDays: e.target.value })}
              />
              {fieldError(i, 'withinDays')}
            </label>
            <button
              type="button"
              className="btn btn--quiet btn--small"
              aria-label={`${t.loyalty.bonusRemove}: ${r.name}`}
              onClick={() => {
                setRows(rows.filter((_, j) => j !== i));
                setProblems([]);
              }}
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
                {
                  name: '',
                  staffIds: [],
                  weekdays: [],
                  multiplier: '2',
                  extraPoints: '0',
                  withinDays: '',
                },
              ])
            }
          >
            {t.loyalty.bonusAdd}
          </button>
        ) : null}
        <button
          className="btn"
          disabled={busy}
          aria-describedby={saveError ? 'bonus-save-error' : undefined}
        >
          {t.loyalty.bonusSave}
        </button>
      </div>
      <FieldError id="bonus-save-error" text={saveError} />
    </form>
  );
}
