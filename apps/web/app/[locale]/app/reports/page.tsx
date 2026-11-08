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
/** Task 260: the label of each "how far ahead" bucket. */
const LEAD_LABELS = {
  sameDay: 'leadSameDay',
  nextDay: 'leadNextDay',
  week: 'leadWeek',
  twoWeeks: 'leadTwoWeeks',
  later: 'leadLater',
} as const;

/** Task 294: the label of each "how long before the visit" bucket of cancellations. */
const NOTICE_LABELS = {
  twoHours: 'noticeTwoHours',
  day: 'noticeDay',
  threeDays: 'noticeThreeDays',
  later: 'noticeLater',
} as const;

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

  // Task 225: only the report goes to the printer ("print-report" in globals.css).
  useEffect(() => {
    document.documentElement.classList.add('print-report');
    return () => document.documentElement.classList.remove('print-report');
  }, []);

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

  /**
   * Task 30: every visit of the period as a CSV file the accountant opens in Excel.
   * Task 238: "till" — the cash journal of the period (owners and managers).
   */
  async function downloadCsv(file: 'visits' | 'till' = 'visits') {
    setDownloading(true);
    setError('');
    try {
      const res = await apiResponse(
        `/v1/organizations/${session.orgId}/locations/${session.location.id}/reports/${file}-csv`,
        { query: { from: range.from, to: range.to, locale } },
      );
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ??
        `${file}-${range.from}-${range.to}.csv`;
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
  /** Task 233: "+10,00 zł" / "−10,00 zł" / "0,00 zł". */
  const signedMoney = (hundredths: number) =>
    `${hundredths > 0 ? '+' : hundredths < 0 ? '−' : ''}${money(Math.abs(hundredths))}`;
  /** Task 237: "Wpłaty" / "Wypłaty" columns only when cash was put in or taken out. */
  const tillMoves =
    report?.tillCloses.days.some((d) => d.cashInGrosze > 0 || d.cashOutGrosze > 0) ?? false;
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
        <div className="page-head__actions">
          <button
            type="button"
            className="btn btn--quiet btn--small"
            title={t.reports.printHint}
            disabled={!report || invalid}
            onClick={() => window.print()}
          >
            {t.reports.print}
          </button>
          <button
            type="button"
            className="btn btn--small"
            disabled={invalid || downloading}
            onClick={() => void downloadCsv()}
          >
            {downloading ? t.reports.downloading : t.reports.csv}
          </button>
          {report?.scope === 'location' ? (
            // Task 238: the till's cash journal — only for those who see the whole salon.
            <button
              type="button"
              className="btn btn--quiet btn--small"
              title={t.reports.tillCsvHint}
              disabled={invalid || downloading}
              onClick={() => void downloadCsv('till')}
            >
              {t.reports.tillCsv}
            </button>
          ) : null}
        </div>
      </div>
      <div className="page report-sheet">
        {report ? (
          <h2 className="print-only" data-testid="report-print-title">
            {t.reports.title} · {report.location.name}
          </h2>
        ) : null}
        <div className="tabs print-hide" role="group" aria-label={t.reports.period}>
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
          <div className="row print-hide">
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

            {report.payments.length > 0 ? (
              <section className="section" data-testid="report-payments">
                <h2>{t.reports.payments}</h2>
                <ol className="report-days">
                  {report.payments.map((p) => {
                    const name =
                      p.method === 'unknown'
                        ? t.reports.paymentsUnknown
                        : t.appointment.paymentMethods[p.method];
                    const share =
                      totals.revenueGrosze > 0
                        ? Math.round((p.revenueGrosze / totals.revenueGrosze) * 100)
                        : 0;
                    return (
                      <li key={p.method}>
                        <span className="small">{name}</span>
                        <span
                          className="report-bar"
                          role="meter"
                          aria-label={name}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={share}
                        >
                          <span style={{ width: `${share}%` }} />
                        </span>
                        <span className="small">
                          {money(p.revenueGrosze)}
                          <span className="muted">
                            {' '}
                            · {fill(t.reports.dayVisits, { n: String(p.paid) })}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ol>
                <p className="small muted">{t.reports.paymentsHint}</p>
              </section>
            ) : null}

            {report.tips.totalGrosze > 0 ? (
              <section className="section" data-testid="report-tips">
                <h2>
                  {t.reports.tips}: {money(report.tips.totalGrosze)}
                </h2>
                <ol className="report-days">
                  {report.tips.staff.map((s) => {
                    const share = Math.round((s.tipsGrosze / report.tips.totalGrosze) * 100);
                    return (
                      <li key={s.id}>
                        <span className="small">{s.displayName}</span>
                        <span
                          className="report-bar"
                          role="meter"
                          aria-label={s.displayName}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={share}
                        >
                          <span style={{ width: `${share}%` }} />
                        </span>
                        <span className="small">
                          {money(s.tipsGrosze)}
                          <span className="muted">
                            {' '}
                            · {fill(t.reports.tipsVisits, { n: String(s.visits) })}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ol>
                <p className="small muted">{t.reports.tipsHint}</p>
              </section>
            ) : null}

            {report.tillCloses.days.length > 0 ? (
              // Task 233: the days of the period whose till was counted ("Zamknij kasę", task 232).
              <section className="section" data-testid="report-till-closes">
                <h2>{t.reports.tillCloses}</h2>
                <div className="report-table-wrap">
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th scope="col">{t.reports.colDay}</th>
                        <th scope="col">{t.reports.colCashVisits}</th>
                        {tillMoves ? (
                          <>
                            <th scope="col">{t.reports.colCashIn}</th>
                            <th scope="col">{t.reports.colCashOut}</th>
                          </>
                        ) : null}
                        <th scope="col">{t.reports.colCounted}</th>
                        <th scope="col">{t.reports.colDifference}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.tillCloses.days.map((d) => (
                        <tr key={d.date}>
                          <th scope="row">{formatDay(d.date, tag)}</th>
                          <td>{money(d.expectedCashGrosze)}</td>
                          {tillMoves ? (
                            <>
                              <td>{money(d.cashInGrosze)}</td>
                              <td>{money(d.cashOutGrosze)}</td>
                            </>
                          ) : null}
                          <td>{money(d.countedCashGrosze)}</td>
                          <td>{signedMoney(d.differenceGrosze)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="small" data-testid="report-till-total">
                  {fill(t.reports.tillClosesTotal, {
                    sum: signedMoney(report.tillCloses.differenceGrosze),
                  })}
                </p>
                <p className="small muted">{t.reports.tillClosesHint}</p>
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

            {report && report.newcomers.clients > 0 ? (
              <section className="section" data-testid="report-newcomers">
                <h2>
                  {t.reports.newcomers}: {report.newcomers.percent}%
                </h2>
                <span
                  className="report-bar"
                  role="meter"
                  aria-label={t.reports.newcomers}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={report.newcomers.percent}
                >
                  <span style={{ width: `${Math.min(100, report.newcomers.percent)}%` }} />
                </span>
                <p className="small muted">
                  {fill(t.reports.newcomersCount, {
                    returned: String(report.newcomers.returned),
                    booked: String(report.newcomers.booked),
                    clients: String(report.newcomers.clients),
                  })}
                </p>
                {report.scope !== 'own' && report.newcomers.staff.length > 1 ? (
                  <ul className="small">
                    {report.newcomers.staff.map((s) => (
                      <li key={s.id}>
                        {s.displayName}:{' '}
                        {fill(t.reports.newcomersCount, {
                          returned: String(s.returned),
                          booked: String(s.booked),
                          clients: String(s.clients),
                        })}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {report.scope !== 'own' ? (
                  <p className="small">
                    <Link href={`/${locale}/app/clients?new=1`}>{t.reports.newcomersList}</Link>
                  </p>
                ) : null}
                <p className="small muted">{t.reports.newcomersHint}</p>
              </section>
            ) : null}

            {report && report.returnInterval.intervals > 0 ? (
              <section className="section" data-testid="report-return-interval">
                <h2>{t.reports.returnInterval}</h2>
                <p>
                  {fill(t.reports.returnIntervalCount, {
                    median: String(report.returnInterval.medianDays),
                    average: String(report.returnInterval.averageDays),
                    n: String(report.returnInterval.intervals),
                  })}
                </p>
                {report.scope !== 'own' && report.returnInterval.staff.length > 1 ? (
                  <ul className="small">
                    {report.returnInterval.staff.map((s) => (
                      <li key={s.id}>
                        {s.displayName}:{' '}
                        {fill(t.reports.returnIntervalCount, {
                          median: String(s.medianDays),
                          average: String(s.averageDays),
                          n: String(s.intervals),
                        })}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="small muted">{t.reports.returnIntervalHint}</p>
              </section>
            ) : null}

            {report && report.scope !== 'own' && report.overdueClients > 0 ? (
              <section className="section" data-testid="report-overdue">
                <h2>⏰ {fill(t.reports.overdueClients, { n: String(report.overdueClients) })}</h2>
                <p className="small">
                  <Link href={`/${locale}/app/clients?overdue=1`}>
                    {t.reports.overdueClientsList}
                  </Link>
                </p>
                <p className="small muted">{t.reports.overdueClientsHint}</p>
              </section>
            ) : null}

            {report && report.scope !== 'own' && report.noShowClients > 0 ? (
              <section className="section" data-testid="report-no-shows">
                <h2>🚫 {fill(t.reports.noShowClients, { n: String(report.noShowClients) })}</h2>
                <p className="small">
                  <Link href={`/${locale}/app/clients?noShows=1`}>
                    {t.reports.noShowClientsList}
                  </Link>
                </p>
                <p className="small muted">{t.reports.noShowClientsHint}</p>
              </section>
            ) : null}

            {report && report.scope !== 'own' && report.onceClients > 0 ? (
              <section className="section" data-testid="report-once">
                <h2>👋 {fill(t.reports.onceClients, { n: String(report.onceClients) })}</h2>
                <p className="small">
                  <Link href={`/${locale}/app/clients?once=1`}>{t.reports.onceClientsList}</Link>
                </p>
                <p className="small muted">{t.reports.onceClientsHint}</p>
              </section>
            ) : null}

            {report && report.scope !== 'own' && report.marketing.clients > 0 ? (
              <section className="section" data-testid="report-marketing">
                <h2>
                  {t.reports.marketing}: {report.marketing.percent}%
                </h2>
                <span
                  className="report-bar"
                  role="meter"
                  aria-label={t.reports.marketing}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={report.marketing.percent}
                >
                  <span style={{ width: `${Math.min(100, report.marketing.percent)}%` }} />
                </span>
                <p className="small muted">
                  {fill(t.reports.marketingCount, {
                    consented: String(report.marketing.consented),
                    clients: String(report.marketing.clients),
                  })}
                  {' · '}
                  {fill(t.reports.marketingNew, { n: String(report.marketing.newInPeriod) })}
                  {report.marketing.unsubscribed > 0
                    ? ` · ${fill(t.reports.marketingUnsubscribed, {
                        n: String(report.marketing.unsubscribed),
                      })}`
                    : null}
                </p>
                <p className="small muted">{t.reports.marketingHint}</p>
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
                    // Task 256: by price-list category, when the price list is grouped.
                    [
                      'byCategory',
                      report.categories.map((c) => ({
                        ...c,
                        id: c.id ?? 'none',
                        name: c.name ?? t.reports.noCategory,
                      })),
                    ],
                  ] as const
                )
                  .filter(([, rows]) => rows.length > 0)
                  .map(([key, rows]) => (
                    <section key={key} className="section" data-testid={`report-${key}`}>
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

                {report.unbookedServices.length > 0 ? (
                  <section className="section" data-testid="report-unbooked">
                    <h2>{t.reports.unbooked}</h2>
                    <ul className="report-unbooked">
                      {report.unbookedServices.map((s) => (
                        <li key={s.id}>
                          <span>{s.name}</span>
                          {s.categoryName ? (
                            <span className="small muted"> · {s.categoryName}</span>
                          ) : null}
                          <span className="small muted"> · {money(s.priceGrosze)}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="small muted">
                      {t.reports.unbookedHint}{' '}
                      <Link href={`/${locale}/app/services`}>{t.reports.unbookedLink}</Link>
                    </p>
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

                {report.leadTime.visits > 0 ? (
                  <section className="section" data-testid="report-lead-time">
                    <h2>
                      {fill(t.reports.leadTime, { n: String(report.leadTime.medianDays ?? 0) })}
                    </h2>
                    <ol className="report-days">
                      {report.leadTime.buckets.map((b) => (
                        <li key={b.key}>
                          <span className="small">{t.reports[LEAD_LABELS[b.key]]}</span>
                          <span className="report-bar" aria-hidden="true">
                            <span
                              style={{ width: `${(b.visits / report.leadTime.visits) * 100}%` }}
                            />
                          </span>
                          <span className="small">
                            {fill(t.reports.dayVisits, { n: String(b.visits) })}
                            {b.online > 0 ? (
                              <span className="muted">
                                {' '}
                                · {fill(t.reports.leadOnline, { n: String(b.online) })}
                              </span>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ol>
                    <p className="small muted">{t.reports.leadHint}</p>
                  </section>
                ) : null}

                {report.cancelNotice.cancelled > 0 ? (
                  <section className="section" data-testid="report-cancel-notice">
                    <h2>{t.reports.cancelNotice}</h2>
                    <ol className="report-days">
                      {report.cancelNotice.buckets.map((b) => (
                        <li key={b.key}>
                          <span className="small">{t.reports[NOTICE_LABELS[b.key]]}</span>
                          <span className="report-bar" aria-hidden="true">
                            <span
                              style={{
                                width: `${(b.cancelled / report.cancelNotice.cancelled) * 100}%`,
                              }}
                            />
                          </span>
                          <span className="small">
                            {fill(t.reports.noticeCancelled, { n: String(b.cancelled) })}
                          </span>
                        </li>
                      ))}
                    </ol>
                    <p className="small muted">{t.reports.noticeHint}</p>
                  </section>
                ) : null}

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
