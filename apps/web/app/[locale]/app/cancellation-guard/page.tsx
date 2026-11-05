'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { ErrorBox, Sheet, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
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
  const [error, setError] = useState('');
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
    const maxChanges = form.changesOn ? int(form.changes, 1, 50) : null;
    const days = int(form.windowDays, 1, 365);
    const lateCancelMinutes = form.lateOn ? int(form.lateMinutes, 1, 60 * 24 * 7) : null;
    const maxNoShows = form.noShowsOn ? int(form.noShows, 1, 20) : null;
    if (
      (form.changesOn && (maxChanges === null || days === null)) ||
      (form.lateOn && lateCancelMinutes === null) ||
      (form.noShowsOn && maxNoShows === null)
    ) {
      return setError(t.guard.badNumber);
    }
    if (form.enabled && !form.changesOn && !form.lateOn && !form.noShowsOn) {
      return setError(t.guard.needRule);
    }
    if (!lock()) return;
    setError('');
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
      setError(errorText(t, err));
    } finally {
      unlock();
    }
  }

  async function release(client: Marked, note: string) {
    if (!lock()) return;
    setError('');
    try {
      await api(`${url}/clients/${client.customerId}/release`, {
        method: 'POST',
        body: note.trim() ? { note: note.trim() } : {},
      });
      setMarked(await api<GuardedClients>(`${url}/clients`));
      setReleasing(null);
      setInfo(t.guard.released);
    } catch (err) {
      setError(errorText(t, err));
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

  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const actionLabel: Record<Action, string> = {
    approval: t.guard.approval,
    phone_only: t.guard.phoneOnly,
    prepay: t.guard.prepay,
  };

  return (
    <>
      <div className="page-head">
        <h1>{t.guard.title}</h1>
      </div>
      <div className="page">
        <p className="small muted">{t.guard.hint}</p>
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
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            <span>
              <strong>{t.guard.enabled}</strong>
            </span>
          </label>
          <fieldset className="section" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>
              <h3>{t.guard.rules}</h3>
            </legend>
            <label className="check">
              <input
                type="checkbox"
                checked={form.changesOn}
                onChange={(e) => set({ changesOn: e.target.checked })}
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
                    onChange={(e) => set({ changes: e.target.value })}
                  />
                </label>
                <label className="field grow">
                  <span>{t.guard.changesWindow}</span>
                  <input
                    inputMode="numeric"
                    value={form.windowDays}
                    onChange={(e) => set({ windowDays: e.target.value })}
                  />
                </label>
              </div>
            ) : null}
            <label className="check">
              <input
                type="checkbox"
                checked={form.lateOn}
                onChange={(e) => set({ lateOn: e.target.checked })}
              />
              <span>{t.guard.lateOn}</span>
            </label>
            {form.lateOn ? (
              <label className="field">
                <span>{t.guard.lateMinutes}</span>
                <input
                  inputMode="numeric"
                  value={form.lateMinutes}
                  onChange={(e) => set({ lateMinutes: e.target.value })}
                />
              </label>
            ) : null}
            <label className="check">
              <input
                type="checkbox"
                checked={form.noShowsOn}
                onChange={(e) => set({ noShowsOn: e.target.checked })}
              />
              <span>{t.guard.noShowsOn}</span>
            </label>
            {form.noShowsOn ? (
              <label className="field">
                <span>{t.guard.noShowsCount}</span>
                <input
                  inputMode="numeric"
                  value={form.noShows}
                  onChange={(e) => set({ noShows: e.target.value })}
                />
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
              <small className="muted">{t.guard.approvalSoon}</small>
            ) : null}
          </fieldset>
          <button className="btn btn--block" disabled={busy}>
            {t.common.save}
          </button>
        </form>

        <h2 style={{ marginTop: 24 }}>{t.guard.clients}</h2>
        {!marked.enabled ? <p className="note">{t.guard.off}</p> : null}
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
              <button
                type="button"
                className="btn btn--small btn--quiet"
                aria-label={fill(t.guard.releaseOne, { name: c.name })}
                onClick={() => {
                  setInfo('');
                  setReleasing(c);
                }}
              >
                {t.guard.release}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {releasing ? (
        <ReleaseSheet
          client={releasing}
          busy={busy}
          onClose={() => setReleasing(null)}
          onRelease={(note) => void release(releasing, note)}
        />
      ) : null}
    </>
  );
}

function ReleaseSheet({
  client,
  busy,
  onClose,
  onRelease,
}: {
  client: Marked;
  busy: boolean;
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
          <button className="btn grow" disabled={busy}>
            {t.guard.releaseYes}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
