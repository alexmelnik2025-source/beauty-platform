'use client';

import { useEffect, useState } from 'react';
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

  /** Task 22: every visit of the period as a CSV file the accountant opens in Excel. */
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
                <b>{money(totals.revenueGrosze)}</b>
                <span className="small muted">
                  {fill(t.reports.paidCount, { n: String(totals.paid) })}
                </span>
              </div>
              <div className="stat">
                <span className="small muted">{t.reports.average}</span>
                <b>{money(totals.averageTicketGrosze)}</b>
                {totals.discountGrosze > 0 ? (
                  <span className="small muted">
                    {fill(t.reports.discounts, { amount: money(totals.discountGrosze) })}
                  </span>
                ) : null}
              </div>
              <div className="stat">
                <span className="small muted">{t.reports.completed}</span>
                <b>{totals.completed}</b>
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
                <b>{totals.clients}</b>
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
            <p className="small muted">{t.reports.revenueNote}</p>
            <p className="small muted">{t.reports.csvHint}</p>

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
                            <th scope="col">{t.reports.colRevenue}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.id}>
                              <th scope="row">{r.name}</th>
                              <td>{r.completed}</td>
                              <td>{r.noShow}</td>
                              <td>{money(r.revenueGrosze)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))}

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
