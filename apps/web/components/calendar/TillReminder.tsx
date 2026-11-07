'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatDay } from '@/lib/time';
import type { TillClose } from '@/lib/types';

/**
 * Task 239: "Kasa nie została zamknięta" — on today's calendar the owner or a manager sees when
 * the till of the latest earlier day with cash was not counted, and opens that day to close it.
 * The server answers only owners and managers; for anyone else nothing is shown.
 */
export function TillReminder({
  base,
  today,
  refresh,
  onOpen,
}: {
  base: string;
  today: string;
  refresh: unknown;
  onOpen: (date: string) => void;
}) {
  const { t, locale } = useI18n();
  const [day, setDay] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<TillClose>(`${base}/reports/till-close`, { query: { date: today } })
      .then((v) => {
        if (alive) setDay(v.unclosedDay);
      })
      .catch(() => {
        if (alive) setDay(null);
      });
    return () => {
      alive = false;
    };
  }, [base, today, refresh]);

  if (!day) return null;
  return (
    <div className="till-strip" role="status" data-testid="till-reminder">
      <strong>{fill(t.calendar.tillUnclosed, { day: formatDay(day, LOCALE_TAGS[locale]) })}</strong>
      <button type="button" className="btn btn--quiet btn--small" onClick={() => onOpen(day)}>
        {t.calendar.tillUnclosedOpen}
      </button>
    </div>
  );
}
