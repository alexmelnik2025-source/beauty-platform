'use client';

import { useState } from 'react';
import { fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatDay } from '@/lib/time';
import type { PublicAppointment } from '@/lib/types';
import { directionsLink } from './SalonProfile';

/**
 * Task 412: "Udostępnij wizytę" on the visit page — when and where, with the route, through the
 * phone's share sheet (a partner, a friend who drives you); without one, the text is copied.
 * As in the client app (task 411).
 */
export function ShareVisit({ visit }: { visit: PublicAppointment }) {
  const { t, locale } = useI18n();
  const [info, setInfo] = useState('');

  async function share() {
    const url = directionsLink(visit.salon);
    const text = fill(t.booking.shareVisitText, {
      service: visit.service.name,
      staff: visit.staff.displayName,
      day: formatDay(visit.date, LOCALE_TAGS[locale]),
      time: visit.time,
      salon: visit.salon.name,
      address: `${visit.salon.addressLine}, ${visit.salon.city}`,
      url,
    });
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: visit.salon.name, text });
        setInfo('');
        return;
      }
      await navigator.clipboard.writeText(text);
      setInfo(t.booking.shareVisitCopied);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setInfo(t.booking.shareVisitFailed);
    }
  }

  return (
    <>
      <button type="button" className="btn btn--quiet btn--block" onClick={() => void share()}>
        {t.booking.shareVisit}
      </button>
      {info ? (
        <p className="small muted" role="status">
          {info}
        </p>
      ) : null}
    </>
  );
}
