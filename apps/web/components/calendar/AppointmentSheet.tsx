'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { calendarErrorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { clockToMinutes, formatDay, formatPrice, minutesToClock, zonedToInstant } from '@/lib/time';
import type { AppointmentDetail, Staff } from '@/lib/types';
import { useSession } from '../Session';
import { ErrorBox, Sheet, Spinner } from '../ui';

type Mode = 'view' | 'move' | 'cancel';

export function AppointmentSheet({
  id,
  base,
  staffList,
  onClose,
  onChanged,
}: {
  id: string;
  base: string;
  staffList: Staff[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const session = useSession();
  const tz = session.location.timezone;
  const manager = session.role !== 'staff';
  const canChange = manager || session.permissions.changeOwnAppointments === true;
  const canOutside = manager || session.permissions.bookOutsideHours === true;

  const [a, setA] = useState<AppointmentDetail | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [move, setMove] = useState({ date: '', time: '', staffId: '', outside: false });
  const [askOutside, setAskOutside] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      const detail = await api<AppointmentDetail>(`${base}/appointments/${id}`);
      setA(detail);
      setMove({ date: detail.date, time: detail.time, staffId: detail.staff.id, outside: false });
    } catch (err) {
      setError(calendarErrorText(t, err));
    }
  }, [base, id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, after: Mode = 'view') {
    setBusy(true);
    setError('');
    try {
      await action();
      onChanged();
      setMode(after);
      setAskOutside(false);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OUTSIDE_WORKING_HOURS' && canOutside) {
        setAskOutside(true);
      }
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') await load();
      setError(calendarErrorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  if (!a) {
    return (
      <Sheet title={t.appointment.title} onClose={onClose}>
        {error ? <ErrorBox>{error}</ErrorBox> : <Spinner />}
      </Sheet>
    );
  }

  const end = minutesToClock(clockToMinutes(a.time) + a.durationMinutes);
  const live = a.status === 'confirmed';
  const started = Date.parse(a.start) <= Date.now();

  const footer =
    mode === 'view' && canChange && live ? (
      <>
        {started ? (
          <>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api(`${base}/appointments/${a.id}/status`, {
                    method: 'POST',
                    body: { version: a.version, status: 'completed' },
                  }),
                )
              }
            >
              {t.appointment.markCame}
            </button>
            <button
              type="button"
              className="btn btn--quiet"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api(`${base}/appointments/${a.id}/status`, {
                    method: 'POST',
                    body: { version: a.version, status: 'no_show' },
                  }),
                )
              }
            >
              {t.appointment.markNoShow}
            </button>
          </>
        ) : null}
        <button type="button" className="btn btn--quiet" onClick={() => setMode('move')}>
          {t.appointment.reschedule}
        </button>
        <button type="button" className="btn btn--danger" onClick={() => setMode('cancel')}>
          {t.appointment.cancelVisit}
        </button>
      </>
    ) : mode === 'view' && canChange && a.status === 'completed' ? (
      // "Paid" earns loyalty stamps or points; undoing it (a refund) takes them back.
      <button
        type="button"
        className={a.paidAt ? 'btn btn--quiet' : 'btn'}
        disabled={busy}
        onClick={() =>
          void run(() =>
            api(`${base}/appointments/${a.id}/payment`, {
              method: 'POST',
              body: { version: a.version, paid: !a.paidAt },
            }),
          )
        }
      >
        {a.paidAt ? t.appointment.unmarkPaid : t.appointment.markPaid}
      </button>
    ) : undefined;

  return (
    <Sheet title={t.appointment.title} onClose={onClose} footer={footer}>
      <div className="chips">
        <span className="chip">{t.appointment.status[a.status]}</span>
        {a.paidAt ? <span className="chip">✓ {t.appointment.paid}</span> : null}
        <span className="chip">
          {a.source === 'online' ? t.appointment.online : t.appointment.manual}
        </span>
        {a.firstVisit ? <span className="chip">{t.appointment.firstVisit}</span> : null}
        {a.staffChosenByClient ? (
          <span className="chip">{t.appointment.chosenByClient}</span>
        ) : null}
      </div>

      <div>
        <div className="display" style={{ fontSize: '1.6rem' }}>
          {a.time}–{end}
        </div>
        <div className="muted">{formatDay(a.date, tag)}</div>
      </div>

      <ErrorBox>{error}</ErrorBox>
      {mode === 'view' && canChange && a.status === 'completed' && !a.paidAt ? (
        <p className="small muted">{t.appointment.paidHint}</p>
      ) : null}

      {mode === 'view' ? (
        <>
          <dl className="kv">
            <dt>{t.appointment.client}</dt>
            <dd>
              {a.customer?.name ?? '—'}
              {a.customer?.phone ? (
                <div className="row" style={{ marginTop: 8 }}>
                  <a className="btn btn--quiet btn--small" href={`tel:${a.customer.phone}`}>
                    {t.appointment.call} {a.customer.phone}
                  </a>
                  <a className="btn btn--quiet btn--small" href={`sms:${a.customer.phone}`}>
                    {t.appointment.sms}
                  </a>
                </div>
              ) : a.customer ? (
                <div className="small muted">{t.appointment.contactsHidden}</div>
              ) : null}
              {a.customer?.email ? <div className="small">{a.customer.email}</div> : null}
            </dd>
            <dt>{t.appointment.service}</dt>
            <dd>
              {a.service.name}
              <span className="muted">
                {' '}
                · {a.durationMinutes} {t.common.minutes}
              </span>
            </dd>
            <dt>{t.appointment.staff}</dt>
            <dd>{a.staff.displayName}</dd>
            {a.priceGrosze !== null ? (
              <>
                <dt>{t.appointment.price}</dt>
                <dd>{formatPrice(a.priceGrosze, session.location.currency, tag)}</dd>
              </>
            ) : null}
            {a.note ? (
              <>
                <dt>{t.appointment.note}</dt>
                <dd>{a.note}</dd>
              </>
            ) : null}
            {a.cancelReason ? (
              <>
                <dt>{t.appointment.cancelReason}</dt>
                <dd>{a.cancelReason}</dd>
              </>
            ) : null}
          </dl>
          {a.history.length ? (
            <div className="stack" style={{ gap: 8 }}>
              <h3>{t.appointment.history}</h3>
              <ul className="history">
                {a.history.map((h, i) => (
                  <li key={i}>
                    <span>
                      {(t.appointment.events as Record<string, string>)[h.type] ?? h.type}
                    </span>
                    <span className="muted">
                      {new Intl.DateTimeFormat(tag, {
                        timeZone: tz,
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      }).format(new Date(h.at))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      {mode === 'move' ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            const minute = clockToMinutes(move.time);
            const start = new Date(zonedToInstant(move.date, minute, tz)).toISOString();
            const key = newIdempotencyKey();
            void run(() =>
              api(`${base}/appointments/${a.id}/reschedule`, {
                method: 'POST',
                idempotencyKey: key,
                body: {
                  version: a.version,
                  start,
                  staffId: move.staffId,
                  allowOutsideHours: move.outside,
                },
              }),
            );
          }}
        >
          <h3>{t.appointment.newTime}</h3>
          <div className="row">
            <label className="field">
              <span>{t.appointment.date}</span>
              <input
                type="date"
                required
                value={move.date}
                onChange={(e) => setMove({ ...move, date: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t.appointment.time}</span>
              <input
                type="time"
                step={300}
                required
                value={move.time}
                onChange={(e) => setMove({ ...move, time: e.target.value })}
              />
            </label>
          </div>
          {manager ? (
            <label className="field">
              <span>{t.appointment.staff}</span>
              <select
                value={move.staffId}
                onChange={(e) => setMove({ ...move, staffId: e.target.value })}
              >
                {staffList
                  .filter((s) => s.active && s.serviceIds.includes(a.service.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayName}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
          {askOutside ? (
            <label className="check">
              <input
                type="checkbox"
                checked={move.outside}
                onChange={(e) => setMove({ ...move, outside: e.target.checked })}
              />
              <span>{t.appointment.outsideHours}</span>
            </label>
          ) : null}
          <div className="row">
            <button type="button" className="btn btn--quiet" onClick={() => setMode('view')}>
              {t.common.back}
            </button>
            <button className="btn" disabled={busy}>
              {t.appointment.saveMove}
            </button>
          </div>
        </form>
      ) : null}

      {mode === 'cancel' ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              api(`${base}/appointments/${a.id}/cancel`, {
                method: 'POST',
                body: { version: a.version, reason },
              }),
            );
          }}
        >
          <label className="field">
            <span>{t.appointment.cancelReason}</span>
            <textarea required value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="row">
            <button type="button" className="btn btn--quiet" onClick={() => setMode('view')}>
              {t.common.back}
            </button>
            <button className="btn btn--danger" disabled={busy}>
              {t.appointment.confirmCancel}
            </button>
          </div>
        </form>
      ) : null}
    </Sheet>
  );
}
