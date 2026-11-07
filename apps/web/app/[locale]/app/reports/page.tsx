'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from '@/components/Session';
import { ErrorBox, Spinner } from '@/components/ui';
import { api, apiResponse } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { addDays, formatDay, formatPrice, todayIn } from '@/lib/time';
import type { SalonReport } from '@/lib/types';

type Period = 'thisMonth' | 'lastMonth' | 'last30' | 'custom';

/** The first and last day of a period, in the salon's own dates. */
function rangeOf(period: Period, today: string): { from: string; to: string } {
  const monthStart = `${today.slice(0, 8)}01`;
  if (period === 'lastMonth') {
    const lastEnd = addDays(monthStart, -1);
    return { from: `${lastEnd.slice(0, 8)}01`, to: lastEnd };
  }
  if (period === 'last30') return { from: addDays(today, -29), to: today };
  return { from: monthStart, to: today };
}

const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

/** Task 31: "+12%" / "−5%" against the days before; nothing when there is nothing to compare. */
function change(now: number, before: number): { text: string; up: boolean } | null {
  if (before <= 0 || now === before) return null;
  const percent = Math.round(((now - before) / before) * 100);
  if (percent === 0) return null;
  return { text: `${percent > 0 ? '+' : '−'}${Math.abs(percent)}%`, up: percent > 0 };
}

/** Monday … Sunday in the reader's language (2026-11-02 was a Monday). */
function weekdayName(weekday: number, localeTag: string): string {
  return new Intl.DateTimeFormat(localeTag, { timeZone: 'UTC', weekday: 'long' }).format(
    new Date(Date.UTC(2026, 10, 1 + weekday)),
  );
}

/**
 * Task 14: the owner's report — visits, revenue, clients, specialists, services, day by day.
 * A specialist with "prices and own results" sees only their own visits (the server decides).
 */
export default function ReportsPage() {
  const { t, locale } = useI18n();
  const session = useSession();
  const tag = LOCALE_TAGS[locale];
  const tz = session.location.timezone;
  const today = todayIn(tz);
  const [period, setPeriod] = useState<Period>('thisMonth');
  const [custom, setCustom] = useState(() => rangeOf('thisMonth', today));
  const [report, setReport] = useState<SalonReport | null>(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const range = period === 'custom' ? custom : rangeOf(period, today);
  const invalid =
    !range.from || !range.to || range.from > range.to || daysBetween(range.from, range.to) >= 366;

  useEffect(() => {
    if (invalid) return;
    let live = true;
    setError('');
    api<SalonReport>(
      `/v1/organizations/${session.orgId}/locations/${session.location.id}/reports?from=${range.from}&to=${range.to}`,
    )
      .then((r) => live && setReport(r))
      .catch((err: unknown) => live && setError(errorText(t, err)));
    return () => {
      live = false;
    };
  }, [session.orgId, session.location.id, range.from, range.to, invalid, t]);

  /** Task 30: every visit of the period as a CSV file the accountant opens in Excel. */
  async function downloadCsv() {
    setDownloading(true);
    setError('');
    try {
      const res = await apiResponse(
        `/v1/organizations/${session.orgId}/locations/${session.location.id}/reports/visits-csv`,
        { query: { from: range.from, to: range.to, locale } },
      );
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ??
        `visits-${range.from}-${range.to}.csv`;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await res.blob());
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setDownloading(false);
    }
  }

  const money = (hundredths: number) =>
    formatPrice(hundredths, report?.location.currency ?? session.location.currency, tag);
  const totals = report?.totals;
  const notCancelled = totals
    ? totals.visits - totals.cancelledByClient - totals.cancelledBySalon
    : 0;
  const maxDay = Math.max(1, ...(report?.days.map((d) => d.revenueGrosze) ?? [1]));
  const maxWeekday = Math.max(1, ...(report?.weekdays.map((d) => d.completed) ?? [1]));
  const previous = report?.previous;
  const occupancy = report?.occupancy;
  const ratings = report?.ratings;
  /** Task 213: stars with one decimal, "4,5". */
  const stars = (average: number) =>
    new Intl.NumberFormat(tag, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
      average,
    );
  const maxStars = Math.max(1, ...(ratings?.stars ?? [1]));
  /** Task 216: "Godziny szczytu" — the hours that have visits on any day, and how many. */
  const busy = report?.busyHours ?? [];
  const busyRange = busy.length
    ? Array.from(
        { length: Math.max(...busy.map((b) => b.hour)) - Math.min(...busy.map((b) => b.hour)) + 1 },
        (_, i) => Math.min(...busy.map((b) => b.hour)) + i,
      )
    : [];
  const busyCell = (weekday: number, hour: number) =>
    busy.find((b) => b.weekday === weekday && b.hour === hour)?.visits ?? 0;
  const maxBusy = Math.max(1, ...busy.map((b) => b.visits));
  /** Task 141: minutes as hours, "12,5". */
  const hours = (minutes: number) =>
    new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(minutes / 60);
  const trend = (now: number, before: number | undefined) => {
    const c = before === undefined ? null : change(now, before);
    return c ? (
      <span className={c.up ? 'report-change report-change--up' : 'report-change'}>{c.text}</span>
    ) : null;
  };

  return (
    <>
      <div className="page-head">
        <h1>{t.reports.title}</h1>
        <button
          type="button"
          className="btn btn--small"
          disabled={invalid || downloading}
          onClick={() => void downloadCsv()}
        >
          {downloading ? t.reports.downloading : t.reports.csv}
        </button>
      </div>
      <div className="page">
        <div className="tabs" role="group" aria-label={t.reports.period}>
          {(['thisMonth', 'lastMonth', 'last30', 'custom'] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={period === p}
              onClick={() => {
                if (p === 'custom') setCustom(range);
                setPeriod(p);
              }}
            >
              {t.reports[p]}
            </button>
          ))}
        </div>
        {period === 'custom' ? (
          <div className="row">
            <label className="field">
              <span>{t.reports.from}</span>
              <input
                type="date"
                value={custom.from}
                max={today}
                onChange={(e) => setCustom({ ...custom, from: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t.reports.to}</span>
              <input
                type="date"
                value={custom.to}
                onChange={(e) => setCustom({ ...custom, to: e.target.value })}
              />
            </label>
          </div>
        ) : null}
        {invalid ? <p className="note">{t.reports.tooLong}</p> : null}
        {report?.scope === 'own' ? <p className="note">{t.reports.ownHint}</p> : null}
        <ErrorBox>{error}</ErrorBox>

        {!report || !totals ? (
          error ? null : (
            <Spinner />
          )
        ) : (
          <>
            <p className="small muted">
              {formatDay(report.from, tag, { short: true })} –{' '}
              {formatDay(report.to, tag, { short: true })}
            </p>
            <div className="stats" data-testid="report-totals">
              <div className="stat">
                <span className="small muted">{t.reports.revenue}</span>
                <b>
                  {money(totals.revenueGrosze)}{' '}
                  {trend(totals.revenueGrosze, previous?.revenueGrosze)}
                </b>
                <span className="small muted">
                  {fill(t.reports.paidCount, { n: String(totals.paid) })}
                </span>
              </div>
              <div className="stat">
                <span className="small muted">{t.reports.average}</span>
                <b>
                  {money(totals.averageTicketGrosze)}{' '}
                  {trend(totals.averageTicketGrosze, previous?.averageTicketGrosze)}
                </b>
                {totals.discountGrosze > 0 ? (
                  <span className="small muted">
                    {fill(t.reports.discounts, { amount: money(totals.discountGrosze) })}
                  </span>
                ) : null}
              </div>
              <div className="stat">
                <span className="small muted">{t.reports.completed}</span>
                <b>
                  {totals.completed} {trend(totals.completed, previous?.completed)}
                </b>
                <span className="small muted">
                  {fill(t.reports.upcoming, { n: String(totals.upcoming) })}
                </span>
              </div>
              <div className="stat">
                <span className="small muted">{t.reports.noShow}</span>
                <b>{totals.noShow}</b>
              </div>
              <div className="stat">
                <span className="small muted">{t.reports.cancelled}</span>
                <b>{totals.cancelledByClient + totals.cancelledBySalon}</b>
                <span className="small muted">
                  {fill(t.reports.cancelledSplit, {
                    client: String(totals.cancelledByClient),
                    salon: String(totals.cancelledBySalon),
                  })}
                </span>
              </div>
              <div className="stat">
                <span className="small muted">{t.reports.clients}</span>
                <b>
                  {totals.clients} {trend(totals.clients, previous?.clients)}
                </b>
                <span className="small muted">
                  {fill(t.reports.newClients, { n: String(totals.newClients) })}
                </span>
              </div>
              <div className="stat">
                <span className="small muted">{t.reports.online}</span>
                <b>{totals.online}</b>
                <span className="small muted">
                  {fill(t.reports.onlineShare, {
                    n: String(notCancelled ? Math.round((totals.online / notCancelled) * 100) : 0),
                  })}
                </span>
              </div>
            </div>
            {previous ? (
              <p className="small muted">
                {fill(t.reports.compared, {
                  from: formatDay(previous.from, tag, { short: true }),
                  to: formatDay(previous.to, tag, { short: true }),
                  revenue: money(previous.revenueGrosze),
                  visits: String(previous.completed),
                })}
              </p>
            ) : null}
            <p className="small muted">{t.reports.revenueNote}</p>
            <p className="small muted">{t.reports.csvHint}</p>

            {occupancy && occupancy.staff.length > 0 ? (
              <section className="section" data-testid="report-occupancy">
                <h2>
                  {t.reports.occupancy}: {occupancy.percent}%
                </h2>
                <ol className="report-days">
                  {occupancy.staff.map((s) => (
                    <li key={s.id}>
                      <span className="small">{s.displayName}</span>
                      <span
                        className="report-bar"
                        role="meter"
                        aria-label={s.displayName}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={s.percent}
                      >
                        <span style={{ width: `${Math.min(100, s.percent)}%` }} />
                      </span>
                      <span className="small">
                        {s.percent}%
                        <span className="muted">
                          {' '}
                          ·{' '}
                          {fill(t.reports.occupancyHours, {
                            booked: hours(s.bookedMinutes),
                            work: hours(s.workMinutes),
                          })}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
                <p className="small muted">{t.reports.occupancyHint}</p>
              </section>
            ) : null}

            {ratings && ratings.average !== null ? (
              <section className="section" data-testid="report-ratings">
                <h2>
                  {t.reports.ratings}: ★ {stars(ratings.average)}
                </h2>
                <p className="small muted">
                  {fill(t.reports.ratingsCount, { n: String(ratings.reviews) })}
                </p>
                <ol className="report-days">
                  {[5, 4, 3, 2, 1].map((n) => {
                    const count = ratings.stars[n - 1] ?? 0;
                    return (
                      <li key={n}>
                        <span className="small">{'★'.repeat(n)}</span>
                        <span
                          className="report-bar"
                          role="meter"
                          aria-label={`${n} ★`}
                          aria-valuemin={0}
                          aria-valuemax={ratings.reviews}
                          aria-valuenow={count}
                        >
                          <span style={{ width: `${(count / maxStars) * 100}%` }} />
                        </span>
                        <span className="small">{count}</span>
                      </li>
                    );
                  })}
                </ol>
                {ratings.staff.length > 0 && report?.scope !== 'own' ? (
                  <ul className="report-ratings-staff">
                    {ratings.staff.map((s) => (
                      <li key={s.id}>
                        <span>{s.displayName}</span>
                        <span className="small muted">
                          {fill(t.reports.ratingsStaff, {
                            stars: stars(s.average),
                            n: String(s.reviews),
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="small muted">{t.reports.ratingsHint}</p>
              </section>
            ) : null}

            {report && report.rebooking.clients > 0 ? (
              <section className="section" data-testid="report-rebooking">
                <h2>
                  {t.reports.rebooking}: {report.rebooking.percent}%
                </h2>
                <p className="small muted">
                  {fill(t.reports.rebookingCount, {
                    rebooked: String(report.rebooking.rebooked),
                    clients: String(report.rebooking.clients),
                  })}
                </p>
                {report.scope !== 'own' ? (
                  <ol className="report-days">
                    {report.rebooking.staff.map((s) => (
                      <li key={s.id}>
                        <span className="small">{s.displayName}</span>
                        <span
                          className="report-bar"
                          role="meter"
                          aria-label={s.displayName}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={s.percent}
                        >
                          <span style={{ width: `${Math.min(100, s.percent)}%` }} />
                        </span>
                        <span className="small">
                          {s.percent}%
                          <span className="muted">
                            {' '}
                            ·{' '}
                            {fill(t.reports.rebookingCount, {
                              rebooked: String(s.rebooked),
                              clients: String(s.clients),
                            })}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : null}
                <p className="small muted">{t.reports.rebookingHint}</p>
              </section>
            ) : null}

            {totals.visits === 0 ? (
              <p className="note">{t.reports.empty}</p>
            ) : (
              <>
                {(
                  [
                    ['byStaff', report.staff.map((s) => ({ ...s, name: s.displayName }))],
                    ['byService', report.services],
                  ] as const
                ).map(([key, rows]) => (
                  <section key={key} className="section">
                    <h2>{t.reports[key]}</h2>
                    <div className="report-table-wrap">
                      <table className="report-table">
                        <thead>
                          <tr>
                            <th scope="col">{t.reports.colName}</th>
                            <th scope="col">{t.reports.colCompleted}</th>
                            <th scope="col">{t.reports.colNoShow}</th>
                            <th scope="col">{t.reports.colCancelled}</th>
                            <th scope="col">{t.reports.colRevenue}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.id}>
                              <th scope="row">{r.name}</th>
                              <td>{r.completed}</td>
                              <td>
                                {r.noShow}
                                {r.noShow > 0 ? (
                                  <span className="small muted">
                                    {' '}
                                    ({Math.round((r.noShow / (r.completed + r.noShow)) * 100)}%)
                                  </span>
                                ) : null}
                              </td>
                              <td>
                                {r.cancelledByClient + r.cancelledBySalon}
                                {r.cancelledByClient + r.cancelledBySalon > 0 ? (
                                  <div className="small muted">
                                    {fill(t.reports.cancelledSplit, {
                                      client: String(r.cancelledByClient),
                                      salon: String(r.cancelledBySalon),
                                    })}
                                  </div>
                                ) : null}
                              </td>
                              <td>{money(r.revenueGrosze)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))}

                {report.topClients.length > 0 ? (
                  <section className="section" data-testid="report-top-clients">
                    <h2>{t.reports.topClients}</h2>
                    <div className="report-table-wrap">
                      <table className="report-table">
                        <thead>
                          <tr>
                            <th scope="col">{t.reports.colClient}</th>
                            <th scope="col">{t.reports.colCompleted}</th>
                            <th scope="col">{t.reports.colRevenue}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.topClients.map((c) => (
                            <tr key={c.id}>
                              <th scope="row">
                                <Link
                                  href={`/${locale}/app/clients?open=${encodeURIComponent(c.id)}`}
                                >
                                  {c.name}
                                </Link>
                              </th>
                              <td>{c.completed}</td>
                              <td>{money(c.revenueGrosze)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="small muted">{t.reports.topClientsHint}</p>
                  </section>
                ) : null}

                <section className="section">
                  <h2>{t.reports.byWeekday}</h2>
                  <ol className="report-days">
                    {report.weekdays.map((d) => (
                      <li key={d.weekday}>
                        <span className="small">{weekdayName(d.weekday, tag)}</span>
                        <span className="report-bar" aria-hidden="true">
                          <span style={{ width: `${(d.completed / maxWeekday) * 100}%` }} />
                        </span>
                        <span className="small">
                          {fill(t.reports.dayVisits, { n: String(d.completed) })}
                          <span className="muted">
                            {' '}
                            · {d.revenueGrosze ? money(d.revenueGrosze) : '—'}
                            {d.noShow
                              ? ` · ${fill(t.reports.weekdayNoShow, { n: String(d.noShow) })}`
                              : ''}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                  <p className="small muted">{t.reports.weekdayHint}</p>
                </section>

                {report.busyHours.length > 0 ? (
                  <section className="section" data-testid="report-busy-hours">
                    <h2>{t.reports.busyHours}</h2>
                    <div className="report-table-wrap">
                      <table className="report-heat">
                        <thead>
                          <tr>
                            <td />
                            {busyRange.map((h) => (
                              <th key={h} scope="col">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {[1, 2, 3, 4, 5, 6, 7].map((weekday) => (
                            <tr key={weekday}>
                              <th scope="row">{weekdayName(weekday, tag)}</th>
                              {busyRange.map((h) => {
                                const n = busyCell(weekday, h);
                                return (
                                  <td
                                    key={h}
                                    title={
                                      n
                                        ? `${weekdayName(weekday, tag)} ${String(h).padStart(2, '0')}:00 · ${fill(t.reports.dayVisits, { n: String(n) })}`
                                        : undefined
                                    }
                                    style={
                                      n
                                        ? {
                                            background: `rgba(17, 17, 17, ${0.12 + 0.88 * (n / maxBusy)})`,
                                            color: n / maxBusy > 0.5 ? '#fff' : 'var(--ink)',
                                          }
                                        : undefined
                                    }
                                  >
                                    {n || ''}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="small muted">{t.reports.busyHoursHint}</p>
                  </section>
                ) : null}

                <section className="section">
                  <h2>{t.reports.byDay}</h2>
                  <ol className="report-days">
                    {report.days.map((d) => (
                      <li key={d.date}>
                        <span className="small">{formatDay(d.date, tag, { short: true })}</span>
                        <span className="report-bar" aria-hidden="true">
                          <span style={{ width: `${(d.revenueGrosze / maxDay) * 100}%` }} />
                        </span>
                        <span className="small">
                          {d.revenueGrosze ? money(d.revenueGrosze) : '—'}
                          <span className="muted">
                            {' '}
                            · {fill(t.reports.dayVisits, { n: String(d.completed) })}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
