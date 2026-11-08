'use client';

import { useEffect, useState } from 'react';
import { LanguagePicker, type Spoken } from '@/components/Languages';
import { useSession } from '@/components/Session';
import { ErrorBox, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import type { Staff, WorkingHours } from '@/lib/types';

type Hours = WorkingHours;

/**
 * A staff member's own hours, special days (task 336) and time off (read only: the owner or a
 * manager changes them).
 */
export default function MySchedulePage() {
  const { t, locale } = useI18n();
  const session = useSession();
  const base = `/v1/organizations/${session.orgId}/locations/${session.location.id}`;
  const [hours, setHours] = useState<Hours | null>(null);
  const [timeOff, setTimeOff] = useState<
    { id: string; start: string; end: string; note: string | null }[]
  >([]);
  const [error, setError] = useState('');
  const [none, setNone] = useState(false);
  const [mine, setMine] = useState<Staff | null>(null);
  const [languages, setLanguages] = useState<Spoken[]>([]);
  const [savedNote, setSavedNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const staff = await api<Staff[]>(`${base}/staff`);
      const mine = staff.find((s) => s.userId === session.me.user.id);
      if (!mine) {
        setNone(true);
        return;
      }
      setMine(mine);
      setLanguages(mine.languages);
      const [h, o] = await Promise.all([
        api<Hours>(`${base}/staff/${mine.id}/working-hours`),
        api<{ id: string; start: string; end: string; note: string | null }[]>(
          `${base}/staff/${mine.id}/time-off`,
        ),
      ]);
      setHours(h);
      setTimeOff(o);
    })().catch((err) => setError(errorText(t, err)));
  }, [base, session.me.user.id, t]);

  /** Task 81: a staff member sets their own languages (shown to clients when booking). */
  async function saveLanguages() {
    if (!mine) return;
    setBusy(true);
    setError('');
    setSavedNote('');
    try {
      const saved = await api<Staff>(`${base}/staff/${mine.id}/languages`, {
        method: 'PUT',
        body: { languages },
      });
      setMine(saved);
      setSavedNote(t.actions.saved);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  const when = (local: string) =>
    new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(`${local}:00Z`));
  /** Task 336: special days (other hours on one date) are shown too. */
  const dayName = (date: string) =>
    new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date(`${date}T12:00:00Z`));

  return (
    <>
      <div className="page-head">
        <h1>{t.more.schedule}</h1>
      </div>
      <div className="page">
        <ErrorBox>{error}</ErrorBox>
        {none ? <p className="note">{t.calendar.noStaff}</p> : null}
        {!hours && !none && !error ? <Spinner /> : null}
        {hours ? (
          <>
            <section className="section" aria-labelledby="my-languages">
              <h2 id="my-languages">{t.languages.myTitle}</h2>
              <LanguagePicker
                title={t.languages.staffTitle}
                hint={t.languages.staffHint}
                value={languages}
                onChange={setLanguages}
              />
              {savedNote ? (
                <p className="note" role="status">
                  {savedNote}
                </p>
              ) : null}
              <button
                type="button"
                className="btn btn--small"
                disabled={busy}
                onClick={() => void saveLanguages()}
              >
                {t.common.save}
              </button>
            </section>
            <section className="section">
              <h2>{t.team.hours}</h2>
              <div>
                {t.weekdays.map((name, i) => {
                  const day = hours.weekly.find((d) => d.weekday === i + 1)?.intervals ?? [];
                  return (
                    <div key={name} className="day-row">
                      <span>{name}</span>
                      <span className={day.length ? '' : 'muted'}>
                        {day.length
                          ? day.map((d) => `${d.start}–${d.end}`).join(', ')
                          : t.team.dayOff}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
            {hours.overrides.length > 0 ? (
              <section className="section">
                <h2>{t.team.special}</h2>
                <div>
                  {hours.overrides.map((d) => (
                    <div key={d.date} className="day-row">
                      <span>{dayName(d.date)}</span>
                      <span className={d.intervals.length ? '' : 'muted'}>
                        {d.intervals.length
                          ? d.intervals.map((i) => `${i.start}–${i.end}`).join(', ')
                          : t.team.dayOff}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            <section className="section">
              <h2>{t.team.timeOff}</h2>
              {timeOff.length === 0 ? <p className="small muted">{t.team.noTimeOff}</p> : null}
              <ul className="history">
                {timeOff.map((o) => (
                  <li key={o.id}>
                    <span>
                      {when(o.start)} – {when(o.end)}
                    </span>
                    <span className="muted">{o.note}</span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}
      </div>
    </>
  );
}
