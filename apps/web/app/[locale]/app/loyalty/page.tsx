'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { costLabel, RewardSheet, rewardLabel } from '@/components/loyalty/RewardSheet';
import { useSession } from '@/components/Session';
import { ErrorBox, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { currencySymbol } from '@/lib/time';
import type { LoyaltyProgram, LoyaltyReward, LoyaltyTransaction, Service } from '@/lib/types';

/** What the form edits: amounts in the salon's currency as typed, empty validity = no limit. */
interface ProgramForm {
  enabled: boolean;
  mode: LoyaltyProgram['mode'];
  stampsPerVisit: number;
  pointsPerUnit: number;
  spendUnit: string;
  minSpend: string;
  pointsValidityDays: string;
  maxDiscountPercent: number;
  allowStacking: boolean;
  marketplaceEnabled: boolean;
}

const zl = (grosze: number) => String(grosze / 100).replace(/\.0+$/, '');
const grosze = (text: string) => Math.round(Number(text.replace(',', '.')) * 100);

function toForm(p: LoyaltyProgram): ProgramForm {
  return {
    enabled: p.enabled,
    mode: p.mode,
    stampsPerVisit: p.stampsPerVisit,
    pointsPerUnit: p.pointsPerUnit,
    spendUnit: zl(p.spendUnitGrosze),
    minSpend: zl(p.minSpendGrosze),
    pointsValidityDays: p.pointsValidityDays === null ? '' : String(p.pointsValidityDays),
    maxDiscountPercent: p.maxDiscountPercent,
    allowStacking: p.allowStacking,
    marketplaceEnabled: p.marketplaceEnabled,
  };
}

/** Rules of the current location: service id → the number typed ('' = general rule). */
function toRules(p: LoyaltyProgram, locationId: string): Record<string, string> {
  return Object.fromEntries(
    p.earnRules
      .filter((r) => r.locationId === locationId)
      .map((r) => [r.serviceId, String(r.points)]),
  );
}

/**
 * "Program lojalnościowy": the salon's own rules (stamp card or points), points per service,
 * the rewards catalogue and the full history. Owners and managers only — the server checks it.
 */
export default function LoyaltyPage() {
  const { t, locale } = useI18n();
  const session = useSession();
  const org = `/v1/organizations/${session.orgId}`;
  const base = `${org}/locations/${session.location.id}`;
  const [program, setProgram] = useState<LoyaltyProgram | null>(null);
  const [form, setForm] = useState<ProgramForm | null>(null);
  const [rules, setRules] = useState<Record<string, string>>({});
  const [services, setServices] = useState<Service[]>([]);
  const [rewards, setRewards] = useState<LoyaltyReward[]>([]);
  const [history, setHistory] = useState<LoyaltyTransaction[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<LoyaltyReward | 'new' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [rulesMessage, setRulesMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const loadProgram = useCallback(async () => {
    const p = await api<LoyaltyProgram>(`${org}/loyalty/program`);
    setProgram(p);
    setForm(toForm(p));
    setRules(toRules(p, session.location.id));
  }, [org, session.location.id]);

  const loadRewards = useCallback(async () => {
    setRewards(
      await api<LoyaltyReward[]>(`${org}/loyalty/rewards`, {
        query: { includeArchived: showArchived },
      }),
    );
  }, [org, showArchived]);

  useEffect(() => {
    Promise.all([
      loadProgram(),
      api<Service[]>(`${base}/services`).then(setServices),
      api<LoyaltyTransaction[]>(`${org}/loyalty/transactions`, { query: { limit: 100 } }).then(
        setHistory,
      ),
    ]).catch((err) => setError(errorText(t, err)));
  }, [base, org, loadProgram, t]);

  useEffect(() => {
    loadRewards().catch((err) => setError(errorText(t, err)));
  }, [loadRewards, t]);

  if (!program || !form) return error ? <ErrorBox>{error}</ErrorBox> : <Spinner />;
  const tag = LOCALE_TAGS[locale];
  // Amounts of the program are in the salon's currency (launch task L5).
  const symbol = currencySymbol(session.location.currency, tag);
  const stamps = form.mode === 'stamps';
  const serviceName = (id: string) =>
    services.find((s) => s.id === id)?.name ?? t.loyalty.otherService;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form || !program) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await api<LoyaltyProgram>(`${org}/loyalty/program`, {
        method: 'PUT',
        body: {
          version: program.version,
          enabled: form.enabled,
          mode: form.mode,
          stampsPerVisit: Number(form.stampsPerVisit),
          pointsPerUnit: Number(form.pointsPerUnit),
          spendUnitGrosze: Math.max(1, grosze(form.spendUnit)),
          minSpendGrosze: grosze(form.minSpend || '0'),
          pointsValidityDays: form.pointsValidityDays ? Number(form.pointsValidityDays) : null,
          maxDiscountPercent: Number(form.maxDiscountPercent),
          allowStacking: form.allowStacking,
          marketplaceEnabled: form.marketplaceEnabled,
        },
      });
      setProgram(saved);
      setForm(toForm(saved));
      setMessage(t.actions.saved);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function saveRules(e: FormEvent) {
    e.preventDefault();
    setError('');
    setRulesMessage('');
    try {
      await api(`${base}/loyalty/earn-rules`, {
        method: 'PUT',
        body: {
          rules: Object.entries(rules)
            .filter(([, points]) => points.trim() !== '')
            .map(([serviceId, points]) => ({ serviceId, points: Number(points) })),
        },
      });
      await loadProgram();
      setRulesMessage(t.actions.saved);
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  const general = stamps
    ? `${form.stampsPerVisit}`
    : `${form.pointsPerUnit} / ${form.spendUnit || '?'} ${symbol}`;

  return (
    <>
      <div className="page-head">
        <h1>{t.loyalty.title}</h1>
      </div>
      <div className="page" style={{ maxWidth: 720 }}>
        <p className="small muted">{t.loyalty.lead}</p>
        <ErrorBox>{error}</ErrorBox>

        <form className="section form" onSubmit={save} aria-labelledby="loyalty-settings">
          <h2 id="loyalty-settings">{t.loyalty.settings}</h2>
          {message ? (
            <p className="note" role="status">
              {message}
            </p>
          ) : null}
          <label className="check">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <span>
              {t.loyalty.enabled}
              <span className="small muted" style={{ display: 'block' }}>
                {t.loyalty.enabledHint}
              </span>
            </span>
          </label>
          <div className="field">
            <span id="loyalty-mode">{t.loyalty.mode}</span>
            <div className="tabs" role="group" aria-labelledby="loyalty-mode">
              {(['stamps', 'points'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={form.mode === mode}
                  onClick={() => setForm({ ...form, mode })}
                >
                  {mode === 'stamps' ? t.loyalty.stamps : t.loyalty.points}
                </button>
              ))}
            </div>
            <span className="small muted">
              {stamps ? t.loyalty.stampsHint : t.loyalty.pointsHint}
            </span>
          </div>
          {stamps ? (
            <label className="field">
              <span>{t.loyalty.stampsPerVisit}</span>
              <input
                type="number"
                min={0}
                max={100}
                required
                value={form.stampsPerVisit}
                onChange={(e) => setForm({ ...form, stampsPerVisit: Number(e.target.value) })}
              />
            </label>
          ) : (
            <div className="row">
              <label className="field">
                <span>{t.loyalty.pointsPerUnit}</span>
                <input
                  type="number"
                  min={0}
                  max={100000}
                  required
                  value={form.pointsPerUnit}
                  onChange={(e) => setForm({ ...form, pointsPerUnit: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                <span>{fill(t.loyalty.spendUnit, { currency: symbol })}</span>
                <input
                  inputMode="decimal"
                  required
                  pattern="\d+([.,]\d{1,2})?"
                  value={form.spendUnit}
                  onChange={(e) => setForm({ ...form, spendUnit: e.target.value })}
                />
              </label>
            </div>
          )}
          <label className="field">
            <span>{fill(t.loyalty.minSpend, { currency: symbol })}</span>
            <input
              inputMode="decimal"
              pattern="\d+([.,]\d{1,2})?"
              value={form.minSpend}
              onChange={(e) => setForm({ ...form, minSpend: e.target.value })}
            />
            <span className="small muted">{t.loyalty.minSpendHint}</span>
          </label>
          <div className="row">
            {stamps ? null : (
              <label className="field">
                <span>{t.loyalty.validity}</span>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={form.pointsValidityDays}
                  onChange={(e) => setForm({ ...form, pointsValidityDays: e.target.value })}
                />
                <span className="small muted">{t.loyalty.noLimitHint}</span>
              </label>
            )}
            <label className="field">
              <span>{t.loyalty.maxDiscount}</span>
              <input
                type="number"
                min={0}
                max={100}
                required
                value={form.maxDiscountPercent}
                onChange={(e) => setForm({ ...form, maxDiscountPercent: Number(e.target.value) })}
              />
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={form.allowStacking}
              onChange={(e) => setForm({ ...form, allowStacking: e.target.checked })}
            />
            <span>{t.loyalty.stacking}</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={form.marketplaceEnabled}
              onChange={(e) => setForm({ ...form, marketplaceEnabled: e.target.checked })}
            />
            <span>
              {t.loyalty.marketplace}
              <span className="small muted" style={{ display: 'block' }}>
                {t.loyalty.marketplaceHint}
              </span>
            </span>
          </label>
          <button className="btn" disabled={busy}>
            {t.common.save}
          </button>
        </form>

        <section className="section">
          <div className="row" style={{ alignItems: 'center' }}>
            <h2 style={{ flex: '1 1 auto' }}>{t.loyalty.rewards}</h2>
            <button type="button" className="btn btn--small" onClick={() => setEditing('new')}>
              + {t.loyalty.addReward}
            </button>
          </div>
          <p className="small muted">{t.loyalty.rewardsHint}</p>
          {rewards.length === 0 ? <p className="note">{t.loyalty.noRewards}</p> : null}
          <ul className="list" aria-label={t.loyalty.rewards}>
            {rewards.map((r) => (
              <li key={r.id}>
                <button type="button" className="list-row" onClick={() => setEditing(r)}>
                  <span className="grow">
                    <strong>{r.name}</strong>
                    <span className="small muted">
                      {rewardLabel(t, r, serviceName)}
                      {r.archivedAt ? ` · ${t.loyalty.archived}` : ''}
                    </span>
                  </span>
                  <span className="chip">{costLabel(t, program.mode, r.cost)}</span>
                </button>
              </li>
            ))}
          </ul>
          <label className="check">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            <span>{t.loyalty.showArchived}</span>
          </label>
        </section>

        <form className="section form" onSubmit={saveRules} aria-labelledby="loyalty-rules">
          <h2 id="loyalty-rules">{t.loyalty.rules}</h2>
          <p className="small muted">{t.loyalty.rulesHint}</p>
          {rulesMessage ? (
            <p className="note" role="status">
              {rulesMessage}
            </p>
          ) : null}
          <ul className="list">
            {services.map((s) => (
              <li key={s.id} className="list-row">
                <label className="grow" htmlFor={`rule-${s.id}`}>
                  <strong>{s.name}</strong>
                </label>
                <input
                  id={`rule-${s.id}`}
                  className="input"
                  style={{ width: 96 }}
                  type="number"
                  min={0}
                  max={100000}
                  placeholder={general}
                  aria-describedby={`rule-unit-${s.id}`}
                  value={rules[s.id] ?? ''}
                  onChange={(e) => setRules({ ...rules, [s.id]: e.target.value })}
                />
                <span id={`rule-unit-${s.id}`} className="small muted" style={{ width: 70 }}>
                  {stamps ? t.loyalty.rulesStamps : t.loyalty.rulesPoints}
                </span>
              </li>
            ))}
          </ul>
          <button className="btn btn--quiet">{t.loyalty.saveRules}</button>
        </form>

        <section className="section" aria-labelledby="loyalty-history">
          <h2 id="loyalty-history">{t.loyalty.history}</h2>
          {history.length === 0 ? <p className="note">{t.loyalty.noHistory}</p> : null}
          <ul className="history">
            {history.map((h) => (
              <li key={h.id}>
                <span>
                  <strong>{h.customer.name}</strong> · {t.loyalty[`type_${h.type}`]}
                  {h.note ? <span className="muted"> — {h.note}</span> : null}
                  <span className="muted" style={{ display: 'block' }}>
                    {new Date(h.createdAt).toLocaleString(tag, {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </span>
                </span>
                <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <strong>{h.points > 0 ? `+${h.points}` : h.points}</strong>
                  <span className="muted" style={{ display: 'block' }}>
                    {fill(t.loyalty.balanceAfter, { count: String(h.balanceAfter) })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {editing ? (
        <RewardSheet
          org={org}
          mode={program.mode}
          reward={editing === 'new' ? null : editing}
          services={services}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            // The first reward also saves the program (with its defaults): read its version.
            void Promise.all([loadRewards(), program.version === 0 ? loadProgram() : null]).catch(
              (err) => setError(errorText(t, err)),
            );
          }}
        />
      ) : null}
    </>
  );
}
