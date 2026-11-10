'use client';

import { useI18n } from '@/lib/i18n';
import { openStatus, openStatusText, salonNow } from '@/lib/open-status';
import type { PublicSalonDirectory } from '@/lib/types';

/**
 * Tasks 363–364: "Otwarte · do 20:00" / "Zamknięte · otwarcie o 10:00" / "Zamknięte" on a salon
 * card (catalogue, home page) — today's real hours of the salon, in its time zone. Render it only
 * in the browser (cards are loaded there), so the time is the reader's "now".
 */
export function OpenNow({
  salon,
}: {
  salon: Pick<PublicSalonDirectory['items'][number], 'timezone' | 'todayHours'>;
}) {
  const { t } = useI18n();
  const now = salonNow(salon.timezone);
  const status = openStatus({ date: now.date, intervals: salon.todayHours }, [], now);
  return (
    <span className="open-status small" data-open={status.kind === 'open' ? 'true' : 'false'}>
      {openStatusText(status, t.profile, () => '')}
    </span>
  );
}
