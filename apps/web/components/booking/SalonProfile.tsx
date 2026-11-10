'use client';

import { useEffect, useState } from 'react';
import { LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { fill } from '@/lib/i18n/locales';
import { openStatus, type OpenStatus } from '@/lib/open-status';
import { todayIn, toLocal } from '@/lib/time';
import type { PublicLocation } from '@/lib/types';

/** Google Maps search for the salon's address; opens the maps app on phones. */
export function mapLink(
  salon: Pick<PublicLocation, 'addressLine' | 'postalCode' | 'city'>,
): string {
  const query = `${salon.addressLine}, ${salon.postalCode} ${salon.city}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/**
 * Task 360: "Jak dojechać" — Google Maps directions to the salon (its app on phones, the site on a
 * computer); the salon's name goes with the address, so the maps find the right door.
 */
export function directionsLink(
  salon: Pick<PublicLocation, 'name' | 'addressLine' | 'postalCode' | 'city'>,
): string {
  const destination = `${salon.name}, ${salon.addressLine}, ${salon.postalCode} ${salon.city}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
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
  // Task 362: today's real hours (special days, vacations) instead of the weekly ones.
  const weeklyToday = days.find((d) => d.weekday === today);
  const todayHours =
    salon.todayHours && salon.todayHours.date === todayIn(salon.timezone)
      ? { weekday: today, intervals: salon.todayHours.intervals }
      : weeklyToday;
  const open = days.some((d) => d.intervals.length > 0) || Boolean(todayHours?.intervals.length);
  const status = useOpenStatus(salon);
  const p = t.profile;
  const statusText = (s: OpenStatus): string => {
    switch (s.kind) {
      case 'open':
        return s.until === '24:00' ? p.openUntilMidnight : fill(p.openUntil, { time: s.until });
      case 'opensToday':
        return fill(p.opensToday, { time: s.at });
      case 'opensLater':
        return fill(p.opensLater, {
          day: s.inDays === 1 ? p.tomorrow : dayName(s.weekday),
          time: s.at,
        });
      case 'closed':
        return p.closedNow;
    }
  };

  return (
    <div className="salon-profile">
      <a className="small map-link" href={mapLink(salon)} target="_blank" rel="noopener noreferrer">
        {t.profile.map}
      </a>
      {salon.description ? <p className="salon-about small">{salon.description}</p> : null}
      {open && status ? (
        <p className="open-status small" data-open={status.kind === 'open' ? 'true' : 'false'}>
          {statusText(status)}
        </p>
      ) : null}
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

/**
 * The salon's status now, in its time zone; null until the page runs in the browser (the server
 * does not know when the page is read). Refreshed every minute.
 */
function useOpenStatus(salon: PublicLocation): OpenStatus | null {
  const [status, setStatus] = useState<OpenStatus | null>(null);
  useEffect(() => {
    const update = () => {
      const now = toLocal(Date.now(), salon.timezone);
      setStatus(
        openStatus(salon.todayHours ?? null, salon.openingHours ?? [], {
          date: now.date,
          weekday: isoWeekday(now.date),
          minute: now.minute,
        }),
      );
    };
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, [salon]);
  return status;
}
