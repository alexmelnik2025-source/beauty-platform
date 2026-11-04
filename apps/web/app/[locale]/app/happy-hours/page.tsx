'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { ErrorBox, Sheet, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import type { Dict } from '@/lib/i18n/pl';
import { useSubmitLock } from '@/lib/submit-lock';
import type { HappyHours, Service, Staff } from '@/lib/types';

type Rule = HappyHours['rules'][number];
type Draft = Omit<Rule, 'id'>;

const EMPTY: Draft = {
  weekdays: [],
  start: '10:00',
  end: '13:00',
  discountPercent: 20,
  staffIds: [],
  serviceIds: [],
};

/** "pon., wt., śr." — short weekday names (ISO 1 = Monday) in the order of the week. */
function daysText(t: Dict, tag: string, weekdays: number[]): string {
  if (weekdays.length === 7) return t.happyHours.everyDay;
  const short = new Intl.DateTimeFormat(tag, { weekday: 'short', timeZone: 'UTC' });
  // 2024-01-01 was a Monday.
  return [...weekdays]
    .sort((a, b) => a - b)
    .map((d) => short.format(new Date(Date.UTC(2024, 0, d))))
    .join(', ');
}

/** Names of the chosen ones; nobody chosen = everyone. */
function namesText(ids: string[], all: { id: string; name: string }[], everyone: string): string {
  if (ids.length === 0) return everyone;
  const names = ids.map((id) => all.find((x) => x.id === id)?.name).filter(Boolean);
  return names.length > 0 ? names.join(', ') : everyone;
}

/**
 * Task 16, part 3: "Happy hours" — a lower price on chosen weekdays and hours, for chosen
 * specialists and services. The server applies it to new visits; clients see "−20%" at the
 * free times. Owner and manager only (the server checks it too).
 */
export default function HappyHoursPage() {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const { orgId, location } = useSession();
  const base = `/v1/organizations/${orgId}/locations/${location.id}`;
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const { busy, lock, unlock } = useSubmitLock();

  const load = useCallback(async () => {
    try {
      const [h, s, st] = await Promise.all([
        api<HappyHours>(`${base}/happy-hours`),
        api<Service[]>(`${base}/services`),
        api<Staff[]>(`${base}/staff`),
      ]);
      setRules(h.rules);
      setServices(s);
      setStaff(st);
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [base, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The server keeps the whole list: every change sends all the rules. */
  async function saveAll(next: Draft[], message: string): Promise<boolean> {
    if (!lock()) return false;
    setError('');
    setInfo('');
    try {
      const saved = await api<HappyHours>(`${base}/happy-hours`, {
        method: 'PUT',
        body: { rules: next },
      });
      setRules(saved.rules);
      setInfo(message);
      return true;
    } catch (err) {
      setError(errorText(t, err));
      return false;
    } finally {
      unlock();
    }
  }

  const drafts = (rules ?? []).map(({ id: _id, ...rest }) => rest);
  const staffNames = staff.map((s) => ({ id: s.id, name: s.displayName }));
  const serviceNames = services.map((s) => ({ id: s.id, name: s.name }));

  if (!rules) {
    return (
      <>
        <div className="page-head">
          <h1>{t.happyHours.title}</h1>
        </div>
        <div className="page">{error ? <ErrorBox>{error}</ErrorBox> : <Spinner />}</div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>{t.happyHours.title}</h1>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => {
            setInfo('');
            setEditing('new');
          }}
        >
          + {t.happyHours.add}
        </button>
      </div>
      <div className="page">
        <p className="small muted">{t.happyHours.hint}</p>
        <ErrorBox>{error}</ErrorBox>
        {info ? (
          <p className="note" role="status">
            {info}
          </p>
        ) : null}
        {rules.length === 0 ? <p className="note">{t.happyHours.empty}</p> : null}
        <ul className="list">
          {rules.map((rule, i) => (
            <li key={rule.id} className="list-row">
              <span className="grow">
                <strong>
                  −{rule.discountPercent}% · {daysText(t, tag, rule.weekdays)} · {rule.start}–
                  {rule.end}
                </strong>
                <span className="small muted">
                  {t.happyHours.staff}:{' '}
                  {namesText(rule.staffIds, staffNames, t.happyHours.allStaff)}
                </span>
                <span className="small muted">
                  {t.happyHours.services}:{' '}
                  {namesText(rule.serviceIds, serviceNames, t.happyHours.allServices)}
                </span>
              </span>
              {confirmRemove === i ? (
                <span className="row" role="group" aria-label={t.happyHours.removeAsk}>
                  <span className="small">{t.happyHours.removeAsk}</span>
                  <button
                    type="button"
                    className="btn btn--danger btn--small"
                    disabled={busy}
                    onClick={() => {
                      setConfirmRemove(null);
                      void saveAll(
                        drafts.filter((_, j) => j !== i),
                        t.happyHours.removed,
                      );
                    }}
                  >
                    {t.happyHours.removeYes}
                  </button>
                  <button
                    type="button"
                    className="btn btn--quiet btn--small"
                    onClick={() => setConfirmRemove(null)}
                  >
                    {t.happyHours.removeNo}
                  </button>
                </span>
              ) : (
                <span className="row">
                  <button
                    type="button"
                    className="link-btn small"
                    aria-label={fill(t.happyHours.editOne, { n: String(i + 1) })}
                    onClick={() => {
                      setInfo('');
                      setEditing(i);
                    }}
                  >
                    {t.happyHours.edit}
                  </button>
                  <button
                    type="button"
                    className="link-btn small"
                    aria-label={fill(t.happyHours.removeOne, { n: String(i + 1) })}
                    onClick={() => setConfirmRemove(i)}
                  >
                    {t.happyHours.remove}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      {editing !== null ? (
        <RuleSheet
          initial={editing === 'new' ? EMPTY : drafts[editing]!}
          isNew={editing === 'new'}
          staff={staffNames}
          services={serviceNames}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            const next =
              editing === 'new'
                ? [...drafts, draft]
                : drafts.map((d, j) => (j === editing ? draft : d));
            if (await saveAll(next, t.happyHours.saved)) setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

function RuleSheet({
  initial,
  isNew,
  staff,
  services,
  busy,
  onClose,
  onSave,
}: {
  initial: Draft;
  isNew: boolean;
  staff: { id: string; name: string }[];
  services: { id: string; name: string }[];
  busy: boolean;
  onClose: () => void;
  onSave: (draft: Draft) => Promise<void>;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<Draft>(initial);
  const [percent, setPercent] = useState(String(initial.discountPercent));
  const [problem, setProblem] = useState('');

  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((x) => x !== id);

  function submit(e: FormEvent) {
    e.preventDefault();
    const discount = Number(percent);
    if (form.weekdays.length === 0) return setProblem(t.happyHours.pickDays);
    if (
      !/^\d{2}:\d{2}$/.test(form.start) ||
      !/^\d{2}:\d{2}$/.test(form.end) ||
      form.start >= form.end
    )
      return setProblem(t.happyHours.badHours);
    if (!Number.isInteger(discount) || discount < 1 || discount > 90)
      return setProblem(t.happyHours.badPercent);
    setProblem('');
    void onSave({ ...form, discountPercent: discount });
  }

  return (
    <Sheet title={isNew ? t.happyHours.add : t.happyHours.edit} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox>{problem}</ErrorBox>
        <fieldset className="section" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>
            <h3>{t.happyHours.days}</h3>
          </legend>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {t.weekdays.map((name, i) => (
              <label key={name} className="check">
                <input
                  type="checkbox"
                  checked={form.weekdays.includes(i + 1)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      weekdays: e.target.checked
                        ? [...form.weekdays, i + 1].sort((a, b) => a - b)
                        : form.weekdays.filter((d) => d !== i + 1),
                    })
                  }
                />
                <span>{name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="row">
          <label className="field grow">
            <span>{t.happyHours.from}</span>
            <input
              type="time"
              step={300}
              required
              value={form.start}
              onChange={(e) => setForm({ ...form, start: e.target.value })}
            />
          </label>
          <label className="field grow">
            <span>{t.happyHours.to}</span>
            <input
              type="time"
              step={300}
              required
              value={form.end}
              onChange={(e) => setForm({ ...form, end: e.target.value })}
            />
          </label>
        </div>
        <label className="field">
          <span>{t.happyHours.percent}</span>
          <input
            inputMode="numeric"
            pattern="[0-9]{1,2}"
            required
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
          />
        </label>
        <fieldset className="section" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>
            <h3>{t.happyHours.staff}</h3>
          </legend>
          {staff.map((s) => (
            <label key={s.id} className="check">
              <input
                type="checkbox"
                checked={form.staffIds.includes(s.id)}
                onChange={(e) =>
                  setForm({ ...form, staffIds: toggle(form.staffIds, s.id, e.target.checked) })
                }
              />
              <span>{s.name}</span>
            </label>
          ))}
          <small className="muted">{t.happyHours.noneMeansAll}</small>
        </fieldset>
        <fieldset className="section" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>
            <h3>{t.happyHours.services}</h3>
          </legend>
          {services.map((s) => (
            <label key={s.id} className="check">
              <input
                type="checkbox"
                checked={form.serviceIds.includes(s.id)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    serviceIds: toggle(form.serviceIds, s.id, e.target.checked),
                  })
                }
              />
              <span>{s.name}</span>
            </label>
          ))}
          <small className="muted">{t.happyHours.noneMeansAll}</small>
        </fieldset>
        <p className="small muted">{t.happyHours.onlyNew}</p>
        <button className="btn btn--block" disabled={busy}>
          {t.common.save}
        </button>
      </form>
    </Sheet>
  );
}
