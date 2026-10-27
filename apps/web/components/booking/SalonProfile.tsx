'use client';

import { LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { todayIn } from '@/lib/time';
import type { PublicLocation } from '@/lib/types';

/** Google Maps search for the salon's address; opens the maps app on phones. */
export function mapLink(
  salon: Pick<PublicLocation, 'addressLine' | 'postalCode' | 'city'>,
): string {
  const query = `${salon.addressLine}, ${salon.postalCode} ${salon.city}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a 'YYYY-MM-DD' date. */
function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** Description, map link and opening hours under the salon name on the booking page. */
export function SalonProfile({ salon }: { salon: PublicLocation }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const days = salon.openingHours ?? [];
  const today = isoWeekday(todayIn(salon.timezone));
  const dayName = (weekday: number) =>
    // 1 January 2024 was a Monday.
    new Intl.DateTimeFormat(tag, { timeZone: 'UTC', weekday: 'long' }).format(
      new Date(Date.UTC(2024, 0, weekday)),
    );
  const hours = (intervals: { start: string; end: string }[]) =>
    intervals.length > 0
      ? intervals.map((i) => `${i.start}–${i.end}`).join(', ')
      : t.profile.closed;
  const todayHours = days.find((d) => d.weekday === today);
  const open = days.some((d) => d.intervals.length > 0);

  return (
    <div className="salon-profile">
      <a className="small map-link" href={mapLink(salon)} target="_blank" rel="noopener noreferrer">
        {t.profile.map}
      </a>
      {salon.description ? <p className="salon-about small">{salon.description}</p> : null}
      {open ? (
        <details className="opening-hours small">
          <summary>
            <span>{t.profile.hours}</span>
            {todayHours ? (
              <span className="muted">
                {' · '}
                {t.profile.today} {hours(todayHours.intervals)}
              </span>
            ) : null}
          </summary>
          <table>
            <tbody>
              {days.map((d) => (
                <tr key={d.weekday} data-today={d.weekday === today ? 'true' : undefined}>
                  <th scope="row">{dayName(d.weekday)}</th>
                  <td>{hours(d.intervals)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}
