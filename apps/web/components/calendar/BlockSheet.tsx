'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatDay, toLocal } from '@/lib/time';
import type { Staff, TimeBlock } from '@/lib/types';
import { useSession } from '../Session';
import { ErrorBox, Sheet } from '../ui';

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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const start = toLocal(block.start, tz);
  const end = toLocal(block.end, tz);
  const staff = staffList.find((s) => s.id === block.staffId);

  async function remove() {
    setBusy(true);
    try {
      await api(`${base}/time-blocks/${block.id}`, { method: 'DELETE' });
      onChanged();
      onClose();
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={t.calendar.blocked}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn--danger" disabled={busy} onClick={remove}>
          {t.appointment.removeBlock}
        </button>
      }
    >
      <ErrorBox>{error}</ErrorBox>
      <div>
        <div className="display" style={{ fontSize: '1.6rem' }}>
          {start.time}–{end.time}
        </div>
        <div className="muted">{formatDay(start.date, LOCALE_TAGS[locale])}</div>
      </div>
      <dl className="kv">
        <dt>{t.appointment.staff}</dt>
        <dd>{staff?.displayName ?? t.calendar.wholeSalon}</dd>
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
