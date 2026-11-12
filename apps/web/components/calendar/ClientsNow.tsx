'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { openStatus, openStatusText, salonNow } from '@/lib/open-status';
import type { Location, PublicLocation } from '@/lib/types';

/**
 * Task 368, "Klienci widzą teraz" — the cabinet's twin of the business app's line (task 366):
 * above today's calendar the owner or a manager sees the salon as clients see it in the catalogue
 * and on the booking page right now ("Otwarte · do 20:00", "Zamknięte · otwarcie: jutro, 10:00")
 * and today's hours for clients — special days, vacations and salon-wide blocks included — so a
 * vacation that closed the salon for booking shows at once. Read from the public salon page with
 * every new calendar data; worked out again every minute. Nothing while online booking is off,
 * while loading or when reading fails: it is a hint.
 */
export function ClientsNow({ base, refresh }: { base: string; refresh: unknown }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const c = t.calendar;
  const [salon, setSalon] = useState<PublicLocation | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    (async () => {
      const location = await api<Location>(base);
      const page = location.onlineBookingEnabled
        ? await api<PublicLocation>(`/v1/public/locations/${location.slug}`, { auth: false })
        : null;
      if (alive) {
        setSalon(page);
        setNow(Date.now());
      }
    })().catch(() => {
      if (alive) setSalon(null);
    });
    return () => {
      alive = false;
    };
  }, [base, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!salon) return null;
  const at = salonNow(salon.timezone, now);
  const weekly = salon.openingHours ?? [];
  const status = openStatus(salon.todayHours ?? null, weekly, at);
  const dayName = (weekday: number) =>
    // 1 January 2024 was a Monday.
    new Intl.DateTimeFormat(tag, { timeZone: 'UTC', weekday: 'long' }).format(
      new Date(Date.UTC(2024, 0, weekday)),
    );
  const line = openStatusText(status, t.profile, dayName);
  const intervals =
    salon.todayHours && salon.todayHours.date === at.date
      ? salon.todayHours.intervals
      : (weekly.find((d) => d.weekday === at.weekday)?.intervals ?? []);
  const today = [...intervals]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((i) => `${i.start}–${i.end}`)
    .join(', ');
  return (
    <div
      className="clients-now"
      role="status"
      aria-label={`${c.clientsNow}: ${line}`}
      data-testid="clients-now"
      title={c.clientsNowHint}
    >
      <span className="muted">{c.clientsNow}:</span>
      <strong className="open-status" data-open={status.kind === 'open' ? 'true' : 'false'}>
        {line}
      </strong>
      <span className="muted">
        {today ? fill(c.clientsNowToday, { hours: today }) : c.clientsNowClosedToday}
      </span>
    </div>
  );
}
