'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PageTitleHelp } from '@/components/PageTitleHelp';
import { useSession } from '@/components/Session';
import { ErrorBox, FieldError, Sheet, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { useSubmitLock } from '@/lib/submit-lock';
import { formatPrice } from '@/lib/time';
import type { CancellationGuard, GuardedClients } from '@/lib/types';

type Action = CancellationGuard['action'];
type Marked = GuardedClients['items'][number];

/** The form keeps every rule's number even while the rule is switched off. */
interface Form {
  enabled: boolean;
  changesOn: boolean;
  changes: string;
  windowDays: string;
  lateOn: boolean;
  lateMinutes: string;
  noShowsOn: boolean;
  noShows: string;
  action: Action;
}

function toForm(g: CancellationGuard): Form {
  return {
    enabled: g.enabled,
    changesOn: g.maxChanges !== null,
    changes: String(g.maxChanges ?? 3),
    windowDays: String(Math.max(1, Math.round(g.windowHours / 24))),
    lateOn: g.lateCancelMinutes !== null,
    lateMinutes: String(g.lateCancelMinutes ?? 120),
    noShowsOn: g.maxNoShows !== null,
    noShows: String(g.maxNoShows ?? 2),
    action: g.action,
  };
}

/** A whole number in [min, max], or null. */
function int(value: string, min: number, max: number): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

const ACTIONS: Action[] = ['approval', 'phone_only', 'prepay'];

/** Task 665: the parts of the form that can show an error under them. */
type GuardField = 'changes' | 'windowDays' | 'lateMinutes' | 'noShows' | 'rules';

/** The allowed range of each number (the server checks the same). */
const RANGES: Record<Exclude<GuardField, 'rules'>, [number, number]> = {
  changes: [1, 50],
  windowDays: [1, 365],
  lateMinutes: [1, 60 * 24 * 7],
  noShows: [1, 20],
};

/** The server's field names → the form's. */
const SERVER_FIELDS: Record<string, GuardField> = {
  maxChanges: 'changes',
  windowHours: 'windowDays',
  lateCancelMinutes: 'lateMinutes',
  maxNoShows: 'noShows',
  enabled: 'rules',
};

/** The fields the server's validation answer is about; empty when it is about something else. */
function guardFieldsOf(err: unknown): GuardField[] {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return [];
  if (!Array.isArray(err.details)) return [];
  const fields = (err.details as { path?: string }[])
    .map((d) => SERVER_FIELDS[String(d.path ?? '')])
    .filter((f): f is GuardField => Boolean(f));
  return [...new Set(fields)];
}

/**
 * Task 161c: "Ochrona przed odwołaniami" — the salon's rules for clients who often cancel,
 * move or miss visits, and the clients marked now with "Zdejmij blokadę". Owner and manager
 * only (the server checks it too). Counting happens on the server from the visit history.
 */
export default function CancellationGuardPage() {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const { orgId, location } = useSession();
  const url = `/v1/organizations/${orgId}/locations/${location.id}/cancellation-guard`;
  const [guard, setGuard] = useState<CancellationGuard | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [marked, setMarked] = useState<GuardedClients | null>(null);
  const [releasing, setReleasing] = useState<Marked | null>(null);
  /**
   * Task 794 (owner's rule: errors where the action is): a refused "Zdejmij oznaczenie" is said in
   * the open sheet under its button — the page behind the sheet is not seen.
   */
  const [releaseError, setReleaseError] = useState('');
  const [error, setError] = useState('');
  /**
   * Task 665 (owner's rule: errors at the field): a number out of range is said under its own
   * field, "tick at least one rule" under the rules; editing a field takes its error away.
   */
  const [problems, setProblems] = useState<GuardField[]>([]);
  const [info, setInfo] = useState('');
  const { busy, lock, unlock } = useSubmitLock();

  const load = useCallback(async () => {
    try {
      const [g, m] = await Promise.all([
        api<CancellationGuard>(url),
        api<GuardedClients>(`${url}/clients`),
      ]);
      setGuard(g);
      setForm(toForm(g));
      setMarked(m);
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [url, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form || !guard) return;
    setInfo('');
    const maxChanges = form.changesOn ? int(form.changes, ...RANGES.changes) : null;
    const days = int(form.windowDays, ...RANGES.windowDays);
    const lateCancelMinutes = form.lateOn ? int(form.lateMinutes, ...RANGES.lateMinutes) : null;
    const maxNoShows = form.noShowsOn ? int(form.noShows, ...RANGES.noShows) : null;
    const before: GuardField[] = [];
    if (form.changesOn && maxChanges === null) before.push('changes');
    if (form.changesOn && days === null) before.push('windowDays');
    if (form.lateOn && lateCancelMinutes === null) before.push('lateMinutes');
    if (form.noShowsOn && maxNoShows === null) before.push('noShows');
    if (form.enabled && !form.changesOn && !form.lateOn && !form.noShowsOn) before.push('rules');
    if (before.length > 0) {
      setError('');
      setProblems(before);
      return;
    }
    if (!lock()) return;
    setError('');
    setProblems([]);
    try {
      const saved = await api<CancellationGuard>(url, {
        method: 'PUT',
        body: {
          version: guard.version,
          enabled: form.enabled,
          maxChanges,
          windowHours: (days ?? 30) * 24,
          lateCancelMinutes,
          maxNoShows,
          action: form.action,
        },
      });
      setGuard(saved);
      setForm(toForm(saved));
      setMarked(await api<GuardedClients>(`${url}/clients`));
      setInfo(t.guard.saved);
    } catch (err) {
      const fields = guardFieldsOf(err);
      setProblems(fields);
      if (fields.length === 0) setError(errorText(t, err));
    } finally {
      unlock();
    }
  }

  async function release(client: Marked, note: string) {
    if (!lock()) return;
    setError('');
    setReleaseError('');
    try {
      await api(`${url}/clients/${client.customerId}/release`, {
        method: 'POST',
        body: note.trim() ? { note: note.trim() } : {},
      });
      setMarked(await api<GuardedClients>(`${url}/clients`));
      setReleasing(null);
      setInfo(t.guard.released);
    } catch (err) {
      setReleaseError(errorText(t, err));
    } finally {
      unlock();
    }
  }

  if (!form || !marked) {
    return (
      <>
        <div className="page-head">
          <h1>{t.guard.title}</h1>
        </div>
        <div className="page">{error ? <ErrorBox>{error}</ErrorBox> : <Spinner />}</div>
      </>
    );
  }

  /** Editing a field (or ticking a rule) takes its error away. */
  const set = (patch: Partial<Form>, field?: GuardField) => {
    setForm({ ...form, ...patch });
    if (field && problems.includes(field)) setProblems(problems.filter((f) => f !== field));
  };
  const problem = (field: GuardField): string | undefined => {
    if (!problems.includes(field)) return undefined;
    if (field === 'rules') return t.guard.needRule;
    const [min, max] = RANGES[field];
    return fill(t.guard.numberRange, { min: String(min), max: String(max) });
  };
  const invalid = (field: GuardField) => ({
    'aria-invalid': problems.includes(field) || undefined,
    'aria-describedby': problems.includes(field) ? `guard-${field}-error` : undefined,
  });
  const actionLabel: Record<Action, string> = {
    approval: t.guard.approval,
    phone_only: t.guard.phoneOnly,
    prepay: t.guard.prepay,
  };

  return (
    <>
      <PageTitleHelp id="guard-help" title={t.guard.title} help={t.guard.hint} />
      <div className="page">
        <ErrorBox>{error}</ErrorBox>
        {info ? (
          <p className="note" role="status">
            {info}
          </p>
        ) : null}
        <form className="form" onSubmit={save}>
          <label className="check">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set({ enabled: e.target.checked }, 'rules')}
            />
            <span>
              <strong>{t.guard.enabled}</strong>
            </span>
          </label>
          <fieldset className="section" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>
              <h3>{t.guard.rules}</h3>
            </legend>
            <FieldError id="guard-rules-error" text={problem('rules')} />
            <label className="check">
              <input
                type="checkbox"
                checked={form.changesOn}
                onChange={(e) => set({ changesOn: e.target.checked }, 'rules')}
              />
              <span>{t.guard.changesOn}</span>
            </label>
            {form.changesOn ? (
              <div className="row">
                <label className="field grow">
                  <span>{t.guard.changesCount}</span>
                  <input
                    inputMode="numeric"
                    value={form.changes}
                    {...invalid('changes')}
                    onChange={(e) => set({ changes: e.target.value }, 'changes')}
                  />
                  <FieldError id="guard-changes-error" text={problem('changes')} />
                </label>
                <label className="field grow">
                  <span>{t.guard.changesWindow}</span>
                  <input
                    inputMode="numeric"
                    value={form.windowDays}
                    {...invalid('windowDays')}
                    onChange={(e) => set({ windowDays: e.target.value }, 'windowDays')}
                  />
                  <FieldError id="guard-windowDays-error" text={problem('windowDays')} />
                </label>
              </div>
            ) : null}
            <label className="check">
              <input
                type="checkbox"
                checked={form.lateOn}
                onChange={(e) => set({ lateOn: e.target.checked }, 'rules')}
              />
              <span>{t.guard.lateOn}</span>
            </label>
            {form.lateOn ? (
              <label className="field">
                <span>{t.guard.lateMinutes}</span>
                <input
                  inputMode="numeric"
                  value={form.lateMinutes}
                  {...invalid('lateMinutes')}
                  onChange={(e) => set({ lateMinutes: e.target.value }, 'lateMinutes')}
                />
                <FieldError id="guard-lateMinutes-error" text={problem('lateMinutes')} />
              </label>
            ) : null}
            <label className="check">
              <input
                type="checkbox"
                checked={form.noShowsOn}
                onChange={(e) => set({ noShowsOn: e.target.checked }, 'rules')}
              />
              <span>{t.guard.noShowsOn}</span>
            </label>
            {form.noShowsOn ? (
              <label className="field">
                <span>{t.guard.noShowsCount}</span>
                <input
                  inputMode="numeric"
                  value={form.noShows}
                  {...invalid('noShows')}
                  onChange={(e) => set({ noShows: e.target.value }, 'noShows')}
                />
                <FieldError id="guard-noShows-error" text={problem('noShows')} />
              </label>
            ) : null}
          </fieldset>
          <fieldset className="section" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>
              <h3>{t.guard.action}</h3>
            </legend>
            {ACTIONS.map((a) => (
              <label key={a} className="check">
                <input
                  type="radio"
                  name="guard-action"
                  checked={form.action === a}
                  onChange={() => set({ action: a })}
                />
                <span>{actionLabel[a]}</span>
              </label>
            ))}
            {form.action === 'prepay' ? (
              <small className="muted">{t.guard.prepayHint}</small>
            ) : null}
            {form.action === 'approval' ? (
              <small className="muted">{t.guard.approvalHint}</small>
            ) : null}
          </fieldset>
          <button className="btn btn--block" disabled={busy}>
            {t.common.save}
          </button>
        </form>

        <h2 style={{ marginTop: 24 }}>{t.guard.clients}</h2>
        {!marked.enabled && marked.items.length === 0 ? (
          <p className="note">{t.guard.off}</p>
        ) : null}
        {marked.enabled && marked.items.length === 0 ? (
          <p className="note">{t.guard.none}</p>
        ) : null}
        <ul className="list">
          {marked.items.map((c) => (
            <li key={c.customerId} className="list-row">
              <span className="grow">
                <strong>{c.name}</strong>
                <span className="small muted">
                  {[
                    c.reasons.includes('changes') &&
                      fill(t.guard.reasonChanges, { n: String(c.changes) }),
                    c.reasons.includes('late_cancel') &&
                      fill(t.guard.reasonLate, { n: String(c.lateCancellations) }),
                    c.reasons.includes('no_shows') &&
                      fill(t.guard.reasonNoShows, { n: String(c.noShows) }),
                    // Task Q9: on the list because of the rule set for this client.
                    c.rule === 'prepay' && t.guard.rulePrepay,
                    c.rule === 'approval' && t.guard.ruleApproval,
                    c.rule === 'phone_only' && t.guard.rulePhoneOnly,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {c.noShowAmountGrosze > 0 ? (
                  <span className="small">
                    {fill(t.guard.owes, {
                      sum: formatPrice(c.noShowAmountGrosze, marked.currency, tag),
                    })}
                  </span>
                ) : null}
                <span className="small muted">{c.phone}</span>
              </span>
              {c.reasons.length === 0 ? null : (
                <button
                  type="button"
                  className="btn btn--small btn--quiet"
                  aria-label={fill(t.guard.releaseOne, { name: c.name })}
                  onClick={() => {
                    setInfo('');
                    setReleasing(c);
                    setReleaseError('');
                  }}
                >
                  {t.guard.release}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {releasing ? (
        <ReleaseSheet
          client={releasing}
          busy={busy}
          error={releaseError}
          onClose={() => {
            setReleasing(null);
            setReleaseError('');
          }}
          onRelease={(note) => void release(releasing, note)}
        />
      ) : null}
    </>
  );
}

function ReleaseSheet({
  client,
  busy,
  error,
  onClose,
  onRelease,
}: {
  client: Marked;
  busy: boolean;
  error: string;
  onClose: () => void;
  onRelease: (note: string) => void;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  return (
    <Sheet title={fill(t.guard.releaseOne, { name: client.name })} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          onRelease(note);
        }}
      >
        <p>{t.guard.releaseAsk}</p>
        <label className="field">
          <span>{t.guard.note}</span>
          <input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="row">
          <button type="button" className="btn btn--quiet grow" onClick={onClose}>
            {t.guard.cancel}
          </button>
          <button
            className="btn grow"
            disabled={busy}
            aria-describedby={error ? 'guard-release-error' : undefined}
          >
            {t.guard.releaseYes}
          </button>
        </div>
        <FieldError id="guard-release-error" text={error} />
      </form>
    </Sheet>
  );
}
