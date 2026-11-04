'use client';

import { useEffect, useState } from 'react';
import { useSession } from '@/components/Session';
import { ErrorBox, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { addDays, formatDay, formatPrice, todayIn } from '@/lib/time';
import type { SalonReport } from '@/lib/types';

type Period = 'week' | 'month' | 'lastMonth' | 'custom';

/** Monday to today, the 1st of the month to its last day, or the whole previous month. */
function rangeOf(period: Exclude<Period, 'custom'>, today: string): { from: string; to: string } {
  if (period === 'week') {
    const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
    return { from: addDays(today, -weekday), to: addDays(today, 6 - weekday) };
  }
  const first = `${today.slice(0, 8)}01`;
  if (period === 'month') {
    return { from: first, to: addDays(`${addDays(first, 31).slice(0, 8)}01`, -1) };
  }
  const lastDay = addDays(first, -1);
  return { from: `${lastDay.slice(0, 8)}01`, to: lastDay };
}

/**
 * "Raporty" (task 14): what happened at the salon in a period — visits, no-shows, what the
 * clients paid after discounts — by staff member, service and day. Owners and managers only;
 * the server checks it.
 */
export default function ReportsPage() {
  const { t, locale } = useI18n();
  const session = useSession();
  const tag = LOCALE_TAGS[locale];
  const tz = session.location.timezone;
  const base = `/v1/organizations/${session.orgId}/locations/${session.location.id}`;
  const [period, setPeriod] = useState<Period>('month');
  const [custom, setCustom] = useState(() => rangeOf('month', todayIn(tz)));
  const [report, setReport] = useState<SalonReport | null>(null);
  const [error, setError] = useState('');

  const range = period === 'custom' ? custom : rangeOf(period, todayIn(tz));
  const { from, to } = range;

  useEffect(() => {
    let live = true;
    setError('');
    if (from > to) return;
    api<SalonReport>(`${base}/reports/summary`, { query: { from, to } })
      .then((r) => {
        if (live) setReport(r);
      })
      .catch((err) => {
        if (live) setError(errorText(t, err));
      });
    return () => {
      live = false;
    };
  }, [base, from, to, t]);

  const money = (hundredths: number) => formatPrice(hundredths, session.location.currency, tag);
  const r = t.reports;
  const periods: [Period, string][] = [
    ['week', r.week],
    ['month', r.month],
    ['lastMonth', r.lastMonth],
    ['custom', r.custom],
  ];

  return (
    <>
      <div className="page-head">
        <h1>{r.title}</h1>
      </div>
      <div className="page">
        <p className="muted small">{r.lead}</p>
        <div className="chips report-periods" role="group" aria-label={r.period}>
          {periods.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {period === 'custom' ? (
          <div className="row">
            <label className="field">
              <span>{r.from}</span>
              <input
                className="input"
                type="date"
                value={custom.from}
                onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{r.to}</span>
              <input
                className="input"
                type="date"
                value={custom.to}
                onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })}
              />
            </label>
          </div>
        ) : null}
        <p className="small">
          {formatDay(from, tag)} – {formatDay(to, tag)}
        </p>
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {!report ? (
          error ? null : (
            <Spinner />
          )
        ) : (
          <ReportView report={report} money={money} tag={tag} />
        )}
      </div>
    </>
  );
}

function ReportView({
  report,
  money,
  tag,
}: {
  report: SalonReport;
  money: (hundredths: number) => string;
  tag: string;
}) {
  const { t } = useI18n();
  const r = t.reports;
  const s = report.totals;
  if (s.appointments === 0) return <p className="muted">{r.empty}</p>;
  const cards: [string, string, string?][] = [
    [
      r.revenue,
      money(s.revenueGrosze),
      s.discountGrosze ? `${r.discount}: −${money(s.discountGrosze)}` : undefined,
    ],
    [r.paidVisits, String(s.paidVisits)],
    [r.averageTicket, s.averageTicketGrosze === null ? '—' : money(s.averageTicketGrosze)],
    [r.completed, String(s.completed), s.upcoming ? `${r.upcoming}: ${s.upcoming}` : undefined],
    [
      r.noShow,
      String(s.noShow),
      s.noShowPercent === null
        ? undefined
        : fill(r.noShowPercent, { percent: String(s.noShowPercent) }),
    ],
    [
      r.cancelled,
      String(s.cancelledByClient + s.cancelledBySalon),
      fill(r.cancelledSplit, {
        client: String(s.cancelledByClient),
        salon: String(s.cancelledBySalon),
      }),
    ],
    [r.clients, String(s.clients), `${r.newClients}: ${s.newClients}`],
    [r.online, String(s.online), `${r.of} ${s.appointments}`],
  ];
  const top = Math.max(1, ...report.byDay.map((d) => d.revenueGrosze));
  return (
    <>
      <ul className="report-cards" aria-label={r.totals}>
        {cards.map(([label, value, note]) => (
          <li key={label} className="report-card">
            <span className="small muted">{label}</span>
            <strong>{value}</strong>
            {note ? <span className="small muted">{note}</span> : null}
          </li>
        ))}
      </ul>

      <section className="section">
        <h2>{r.byDay}</h2>
        <div className="report-bars" role="list" aria-label={r.byDay}>
          {report.byDay.map((d) => (
            <div
              key={d.date}
              role="listitem"
              className="report-bar"
              title={`${formatDay(d.date, tag, { short: true })}: ${money(d.revenueGrosze)} · ${r.visits}: ${d.completed}`}
              aria-label={`${formatDay(d.date, tag, { short: true })}: ${money(d.revenueGrosze)}, ${r.visits}: ${d.completed}`}
            >
              <span style={{ height: `${Math.round((d.revenueGrosze / top) * 100)}%` }} />
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>{r.byStaff}</h2>
        <table className="report-table" aria-label={r.byStaff}>
          <thead>
            <tr>
              <th scope="col">{r.staff}</th>
              <th scope="col">{r.visits}</th>
              <th scope="col">{r.noShow}</th>
              <th scope="col">{r.revenue}</th>
            </tr>
          </thead>
          <tbody>
            {report.byStaff.map((row) => (
              <tr key={row.staffId}>
                <th scope="row">{row.displayName}</th>
                <td>{row.completed}</td>
                <td>{row.noShow}</td>
                <td>{money(row.revenueGrosze)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="section">
        <h2>{r.byService}</h2>
        <table className="report-table" aria-label={r.byService}>
          <thead>
            <tr>
              <th scope="col">{r.service}</th>
              <th scope="col">{r.visits}</th>
              <th scope="col">{r.paid}</th>
              <th scope="col">{r.revenue}</th>
            </tr>
          </thead>
          <tbody>
            {report.byService.map((row) => (
              <tr key={row.serviceId}>
                <th scope="row">{row.name}</th>
                <td>{row.completed}</td>
                <td>{row.paidVisits}</td>
                <td>{money(row.revenueGrosze)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
