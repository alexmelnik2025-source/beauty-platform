'use client';

import { useEffect, useState } from 'react';
import { LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { openStatus, openStatusText, salonNow, type OpenStatus } from '@/lib/open-status';
import { todayIn } from '@/lib/time';
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

/** Map link, description and opening hours — inside the folded "O salonie" on the booking page. */
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
  const open = hasHours(salon);

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

/** Whether the salon has any opening hours to show (weekly or today's). */
function hasHours(salon: PublicLocation): boolean {
  return (
    (salon.openingHours ?? []).some((d) => d.intervals.length > 0) ||
    Boolean(salon.todayHours?.intervals.length)
  );
}

/**
 * Task 362: "Otwarte · do 20:00" / "Zamknięte · otwarcie o 10:00". Task Q5: on the folded
 * "O salonie" line, so the client sees it without opening the salon's details.
 */
export function SalonOpenStatus({ salon }: { salon: PublicLocation }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const status = useOpenStatus(salon);
  if (!hasHours(salon) || !status) return null;
  const dayName = (weekday: number) =>
    new Intl.DateTimeFormat(tag, { timeZone: 'UTC', weekday: 'long' }).format(
      new Date(Date.UTC(2024, 0, weekday)),
    );
  return (
    <span className="open-status small" data-open={status.kind === 'open' ? 'true' : 'false'}>
      {openStatusText(status, t.profile, dayName)}
    </span>
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
      setStatus(
        openStatus(salon.todayHours ?? null, salon.openingHours ?? [], salonNow(salon.timezone)),
      );
    };
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, [salon]);
  return status;
}
