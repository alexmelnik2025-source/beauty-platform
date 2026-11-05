'use client';

import { useEffect, useState } from 'react';
import { useSession } from '@/components/Session';
import { ErrorBox, Spinner } from '@/components/ui';
import { DRINK_ICON, hasWishes, MOOD_ICON } from '@/components/wishes/wishes';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { addDays, formatDay, todayIn, toLocal } from '@/lib/time';
import type { Calendar } from '@/lib/types';

type Row =
  | { kind: 'visit'; start: string; end: string; a: Calendar['appointments'][number] }
  | { kind: 'block'; start: string; end: string; reason: string | null; whole: boolean };

/**
 * Task 142: "Drukuj plan dnia" — the day of every specialist on one A4 page: visits by time
 * (service, client, phone only when the server shows it to this person, wishes as icons) and
 * blocked time. Only `.day-plan` is printed (`html.print-plan` in globals.css).
 */
export default function DayPlanPrintPage() {
  const { t, locale } = useI18n();
  const session = useSession();
  const { orgId, location } = session;
  const tag = LOCALE_TAGS[locale];
  const tz = location.timezone;
  const [date, setDate] = useState(() => {
    const wanted =
      typeof window === 'undefined'
        ? null
        : new URLSearchParams(window.location.search).get('date');
    return wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : todayIn(tz);
  });
  const [data, setData] = useState<Calendar | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.documentElement.classList.add('print-plan');
    return () => document.documentElement.classList.remove('print-plan');
  }, []);

  useEffect(() => {
    let live = true;
    setData(null);
    setError('');
    api<Calendar>(`/v1/organizations/${orgId}/locations/${location.id}/calendar`, {
      query: { from: date, to: date },
    })
      .then((c) => live && setData(c))
      .catch((err: unknown) => live && setError(errorText(t, err)));
    return () => {
      live = false;
    };
  }, [orgId, location.id, date, t]);

  const p = t.dayPlan;
  const time = (iso: string) => toLocal(iso, tz).time;

  const rowsOf = (staffId: string): Row[] => {
    if (!data) return [];
    const visits: Row[] = data.appointments
      .filter((a) => a.staff.id === staffId && a.status !== 'cancelled' && a.status !== 'expired')
      .map((a) => ({ kind: 'visit', start: a.start, end: a.end, a }));
    const blocks: Row[] = data.blocks
      .filter((b) => b.staffId === staffId || b.staffId === null)
      .map((b) => ({
        kind: 'block',
        start: b.start,
        end: b.end,
        reason: b.reason,
        whole: b.staffId === null,
      }));
    return [...visits, ...blocks].sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
  };

  return (
    <>
      <div className="page-head no-print">
        <h1>{p.title}</h1>
        <button
          type="button"
          className="btn btn--small"
          disabled={!data}
          onClick={() => window.print()}
        >
          {p.print}
        </button>
      </div>
      <div className="page">
        <div className="row no-print">
          <button
            type="button"
            className="icon-btn"
            aria-label={t.calendar.previousDay}
            onClick={() => setDate(addDays(date, -1))}
          >
            ‹
          </button>
          <label className="field">
            <span className="visually-hidden">{p.day}</span>
            <input
              type="date"
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="icon-btn"
            aria-label={t.calendar.nextDay}
            onClick={() => setDate(addDays(date, 1))}
          >
            ›
          </button>
        </div>
        <ErrorBox>{error}</ErrorBox>
        {!data ? (
          error ? null : (
            <Spinner />
          )
        ) : (
          <article className="day-plan" data-testid="day-plan">
            <header className="day-plan__head">
              <h2>{formatDay(date, tag)}</h2>
              <span>{data.location.name}</span>
            </header>
            {data.staff.length === 0 ? <p className="muted">{t.calendar.noStaff}</p> : null}
            {data.staff.map((s) => {
              const hours = s.days.find((d) => d.date === date)?.intervals ?? [];
              const off = data.timeOff.filter((o) => o.staffId === s.id);
              const rows = rowsOf(s.id);
              return (
                <section key={s.id} className="day-plan__staff" aria-label={s.displayName}>
                  <h3>
                    {s.displayName}{' '}
                    <span className="day-plan__hours">
                      {hours.length
                        ? hours.map((i) => `${i.start}–${i.end}`).join(', ')
                        : t.calendar.dayOff}
                      {off.length ? ` · ${p.timeOff}` : ''}
                    </span>
                  </h3>
                  {rows.length === 0 ? (
                    <p className="muted small">{p.noVisits}</p>
                  ) : (
                    <table className="day-plan__table">
                      <thead>
                        <tr>
                          <th scope="col">{p.colTime}</th>
                          <th scope="col">{p.colService}</th>
                          <th scope="col">{p.colClient}</th>
                          <th scope="col">{p.colNotes}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) =>
                          r.kind === 'block' ? (
                            <tr key={`b-${r.start}-${r.end}`} className="day-plan__block">
                              <td>
                                {time(r.start)}–{time(r.end)}
                              </td>
                              <td colSpan={3}>
                                {t.calendar.blocked}
                                {r.reason ? `: ${r.reason}` : ''}
                                {r.whole ? ` (${t.calendar.wholeSalon})` : ''}
                              </td>
                            </tr>
                          ) : (
                            <tr key={r.a.id}>
                              <td>
                                {time(r.start)}–{time(r.end)}
                              </td>
                              <td>{r.a.service.name}</td>
                              <td>
                                {r.a.customer?.name ?? '—'}
                                {r.a.customer?.phone ? (
                                  <span className="day-plan__phone"> {r.a.customer.phone}</span>
                                ) : null}
                                {r.a.firstVisit ? (
                                  <span className="day-plan__tag"> · {p.firstVisit}</span>
                                ) : null}
                              </td>
                              <td>
                                {r.a.status === 'held' ? `${t.calendar.held}. ` : null}
                                {hasWishes(r.a.wishes) ? (
                                  <>
                                    {r.a.wishes.mood ? (
                                      <span title={t.wishes.mood[r.a.wishes.mood]}>
                                        {MOOD_ICON[r.a.wishes.mood]}{' '}
                                      </span>
                                    ) : null}
                                    {r.a.wishes.drink ? (
                                      <span title={t.wishes.drink[r.a.wishes.drink]}>
                                        {DRINK_ICON[r.a.wishes.drink]}{' '}
                                      </span>
                                    ) : null}
                                    {r.a.wishes.note ? `✍️ ${r.a.wishes.note} ` : null}
                                  </>
                                ) : null}
                                {r.a.note ?? null}
                              </td>
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  )}
                </section>
              );
            })}
            <footer className="day-plan__foot small muted">
              {fill(p.printed, {
                at: new Intl.DateTimeFormat(tag, {
                  timeZone: tz,
                  dateStyle: 'short',
                  timeStyle: 'short',
                }).format(new Date()),
              })}
            </footer>
          </article>
        )}
      </div>
    </>
  );
}
