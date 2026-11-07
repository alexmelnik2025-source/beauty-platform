'use client';

import { useState } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { calendarErrorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { clockToMinutes, formatDay, minutesToClock, zonedToInstant } from '@/lib/time';
import type { Appointment, Staff } from '@/lib/types';
import { ErrorBox, Sheet } from '../ui';

/** Where a visit was dropped in the calendar (task 221). */
export interface MoveTarget {
  appointment: Appointment;
  date: string;
  staffId: string;
  minute: number;
}

/**
 * Task 221: after a visit is dragged to another time or specialist, the salon confirms the
 * move. It goes through the same "reschedule" call as "Przenieś" in the visit card, so the
 * server checks the rights, the specialist's services, collisions and working hours; outside
 * working hours the move is offered again with "save outside working hours" for those allowed.
 */
export function MoveSheet({
  target,
  base,
  tz,
  staffList,
  canOutside,
  onClose,
  onMoved,
}: {
  target: MoveTarget;
  base: string;
  tz: string;
  staffList: Staff[];
  canOutside: boolean;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const a = target.appointment;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [askOutside, setAskOutside] = useState(false);
  const [outside, setOutside] = useState(false);
  const [key] = useState(newIdempotencyKey);

  const name = (id: string) =>
    staffList.find((s) => s.id === id)?.displayName ?? a.staff.displayName;
  const span = (minute: number) =>
    `${minutesToClock(minute)}–${minutesToClock(minute + a.durationMinutes)}`;
  const was = `${span(clockToMinutes(a.time))} · ${a.staff.displayName}`;
  const will = `${span(target.minute)} · ${name(target.staffId)}`;

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api(`${base}/appointments/${a.id}/reschedule`, {
        method: 'POST',
        // A new key once the salon allows "outside working hours": it is a different request.
        idempotencyKey: outside ? `${key}-outside` : key,
        body: {
          version: a.version,
          start: new Date(zonedToInstant(target.date, target.minute, tz)).toISOString(),
          staffId: target.staffId,
          allowOutsideHours: outside,
        },
      });
      onMoved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OUTSIDE_WORKING_HOURS' && canOutside) {
        setAskOutside(true);
      }
      setError(calendarErrorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={t.calendar.moveTitle}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--quiet" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || (askOutside && !outside)}
            onClick={() => void save()}
          >
            {t.appointment.saveMove}
          </button>
        </>
      }
    >
      <div>
        <strong>{a.customer?.name ?? '—'}</strong>
        <div className="muted">{a.service.name}</div>
        <div className="muted">{formatDay(target.date, tag)}</div>
      </div>
      <dl className="kv" data-testid="move-summary">
        <dt>{t.calendar.moveWas}</dt>
        <dd>{was}</dd>
        <dt>{t.calendar.moveWill}</dt>
        <dd>
          <strong>{will}</strong>
        </dd>
      </dl>
      <ErrorBox>{error}</ErrorBox>
      {askOutside ? (
        <label className="check">
          <input type="checkbox" checked={outside} onChange={(e) => setOutside(e.target.checked)} />
          <span>{t.appointment.outsideHours}</span>
        </label>
      ) : null}
    </Sheet>
  );
}
