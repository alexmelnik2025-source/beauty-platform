'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatDay, toLocal } from '@/lib/time';
import type { Staff, TimeBlock } from '@/lib/types';
import { useSession } from '../Session';
import { FieldError, Sheet } from '../ui';

export function BlockSheet({
  block,
  base,
  staffList,
  onClose,
  onChanged,
}: {
  block: TimeBlock;
  base: string;
  staffList: Staff[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, locale } = useI18n();
  const session = useSession();
  const tz = session.location.timezone;
  /**
   * Task 836 (owner's rule: errors where the action is): a refused removal is said under the
   * buttons and tied to the pressed one ("Usuń blokadę" or "Usuń całą serię"), not as a box.
   */
  const [error, setError] = useState<{ series: boolean; text: string } | null>(null);
  const errorId = 'block-remove-error';
  const describedBy = (series: boolean) => (error && error.series === series ? errorId : undefined);
  const [busy, setBusy] = useState(false);
  const start = toLocal(block.start, tz);
  const end = toLocal(block.end, tz);
  const staff = staffList.find((s) => s.id === block.staffId);

  async function remove(series = false) {
    setBusy(true);
    setError(null);
    try {
      await api(
        series && block.seriesId
          ? `${base}/time-blocks/series/${block.seriesId}`
          : `${base}/time-blocks/${block.id}`,
        { method: 'DELETE' },
      );
      onChanged();
      onClose();
    } catch (err) {
      // Task 727: someone else (another device, the app) has already removed it — the calendar
      // is refreshed and the sheet closes, as after a removal, instead of "Nie znaleziono.".
      if (err instanceof ApiError && err.code === 'NOT_FOUND') {
        onChanged();
        onClose();
        return;
      }
      setError({ series, text: errorText(t, err) });
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={t.calendar.blocked}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy}
            aria-describedby={describedBy(false)}
            onClick={() => void remove()}
          >
            {t.appointment.removeBlock}
          </button>
          {block.seriesId ? (
            <button
              type="button"
              className="btn btn--quiet"
              disabled={busy}
              aria-describedby={describedBy(true)}
              onClick={() => void remove(true)}
            >
              {t.appointment.removeSeries}
            </button>
          ) : null}
          {/* Task 727: in the footer, not at the top of the sheet; task 836: on its own line under
              the buttons. */}
          <FieldError id={errorId} text={error?.text} />
        </>
      }
    >
      <div>
        <div className="display" style={{ fontSize: '1.6rem' }}>
          {start.time}–{end.time}
        </div>
        <div className="muted">{formatDay(start.date, LOCALE_TAGS[locale])}</div>
      </div>
      <dl className="kv">
        <dt>{t.appointment.staff}</dt>
        <dd>{staff?.displayName ?? t.calendar.wholeSalon}</dd>
        {block.seriesId ? (
          <>
            <dt>{t.appointment.repeatWeekly}</dt>
            <dd>{t.appointment.weeklySeries}</dd>
          </>
        ) : null}
        {block.reason ? (
          <>
            <dt>{t.appointment.note}</dt>
            <dd>{block.reason}</dd>
          </>
        ) : null}
      </dl>
    </Sheet>
  );
}
