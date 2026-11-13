'use client';

import { useState } from 'react';
import { useSession } from '@/components/Session';
import { ErrorBox } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';
import type { SalonReport, StaffCommissions } from '@/lib/types';

/** "45,5%" in the reader's language. */
function percentText(percent: number, localeTag: string): string {
  return `${new Intl.NumberFormat(localeTag, { maximumFractionDigits: 1 }).format(percent)}%`;
}

/** What the owner typed, "45,5" or "45.5" → 45.5; '' → null; anything else → undefined. */
function parsePercent(text: string): number | null | undefined {
  const value = text.trim().replace(',', '.');
  if (value === '') return null;
  if (!/^\d{1,3}(\.\d)?$/.test(value)) return undefined;
  const percent = Number(value);
  return percent <= 100 ? percent : undefined;
}

/**
 * Task 374: "Prowizje" — what each specialist gets of what their paid visits brought, by the
 * percent the salon set. Owners and managers (scope "location") also set the percents here;
 * a specialist with own results sees only their own line. Nothing is shown when no
 * commission is set and the reader cannot set one.
 */
export function Commissions({
  report,
  localeTag,
  money,
  onSaved,
}: {
  report: SalonReport;
  localeTag: string;
  money: (hundredths: number) => string;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const canSet = report.scope === 'location';
  const rows = report.staff.filter((s) => s.commissionPercent !== null);
  const [list, setList] = useState<StaffCommissions['staff'] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const base = `/v1/organizations/${session.orgId}/locations/${session.location.id}/reports/commissions`;

  if (!canSet && rows.length === 0) return null;
  const total = rows.reduce((sum, r) => sum + (r.commissionGrosze ?? 0), 0);
  // Task 390: "Do wypłaty" — the commission plus the tips the specialist got in the period.
  const tipsOf = (id: string) => report.tips.staff.find((s) => s.id === id)?.tipsGrosze ?? 0;
  const withTips = rows.some((r) => tipsOf(r.id) > 0);
  const payout = rows.reduce((sum, r) => sum + (r.commissionGrosze ?? 0) + tipsOf(r.id), 0);

  function show(next: StaffCommissions) {
    setList(next.staff);
    setDrafts(
      Object.fromEntries(
        next.staff.map((s) => [
          s.staffId,
          s.commissionPercent === null
            ? ''
            : new Intl.NumberFormat(localeTag, {
                maximumFractionDigits: 1,
                useGrouping: false,
              }).format(s.commissionPercent),
        ]),
      ),
    );
  }

  async function open() {
    if (list) return;
    setError('');
    try {
      show(await api<StaffCommissions>(base));
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  async function save(staffId: string) {
    const commissionPercent = parsePercent(drafts[staffId] ?? '');
    if (commissionPercent === undefined) {
      setError(t.reports.commissionInvalid);
      return;
    }
    setSaving(staffId);
    setSaved('');
    setError('');
    try {
      show(
        await api<StaffCommissions>(`${base}/${staffId}`, {
          method: 'PUT',
          body: { commissionPercent },
        }),
      );
      setSaved(staffId);
      onSaved();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setSaving('');
    }
  }

  return (
    <section className="section" data-testid="report-commissions">
      <h2>
        {t.reports.commissions}
        {rows.length > 0 ? `: ${money(total)}` : null}
      </h2>
      {rows.length > 0 ? (
        <div className="report-table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th scope="col">{t.reports.colName}</th>
                <th scope="col">{t.reports.colRevenue}</th>
                <th scope="col">{t.reports.colCommission}</th>
                <th scope="col">{t.reports.colCommissionAmount}</th>
                {withTips ? (
                  <>
                    <th scope="col">{t.reports.colPayoutTips}</th>
                    <th scope="col">{t.reports.colPayout}</th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.displayName}</th>
                  <td>{money(r.revenueGrosze)}</td>
                  <td>{percentText(r.commissionPercent!, localeTag)}</td>
                  <td>{money(r.commissionGrosze ?? 0)}</td>
                  {withTips ? (
                    <>
                      <td>{money(tipsOf(r.id))}</td>
                      <td>
                        <strong>{money((r.commissionGrosze ?? 0) + tipsOf(r.id))}</strong>
                      </td>
                    </>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {withTips ? (
        <p data-testid="report-payout">{fill(t.reports.payoutTotal, { amount: money(payout) })}</p>
      ) : null}
      <p className="small muted">{t.reports.commissionsHint}</p>
      {canSet ? (
        <details
          className="print-hide"
          onToggle={(e) => {
            if ((e.currentTarget as HTMLDetailsElement).open) void open();
          }}
        >
          <summary>{t.reports.commissionsSet}</summary>
          {error ? <ErrorBox>{error}</ErrorBox> : null}
          {list ? (
            <ul className="commission-list" data-testid="commission-list">
              {list.map((s) => (
                <li key={s.staffId} className="commission-row">
                  <label htmlFor={`commission-${s.staffId}`}>
                    {s.displayName}
                    {s.active ? null : (
                      <span className="small muted"> · {t.reports.commissionInactive}</span>
                    )}
                  </label>
                  <span className="commission-row__input">
                    <input
                      id={`commission-${s.staffId}`}
                      inputMode="decimal"
                      placeholder={t.reports.commissionNone}
                      value={drafts[s.staffId] ?? ''}
                      onChange={(e) => {
                        setSaved('');
                        setDrafts({ ...drafts, [s.staffId]: e.target.value });
                      }}
                    />
                    <span aria-hidden="true">%</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={saving !== ''}
                    onClick={() => void save(s.staffId)}
                  >
                    {saving === s.staffId ? t.reports.commissionSaving : t.reports.commissionSave}
                  </button>
                  {saved === s.staffId ? (
                    <span className="small" role="status">
                      {t.reports.commissionSaved}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="small muted">{t.reports.commissionsSetHint}</p>
        </details>
      ) : null}
    </section>
  );
}
