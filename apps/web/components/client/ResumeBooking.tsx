'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fill, useI18n } from '@/lib/i18n';
import {
  clearBookingPlace,
  loadBookingPlace,
  placeQuery,
  type BookingPlace,
} from '@/lib/install-banner';

/**
 * Task Q2 (part 4): "Finish your booking" at the top of "My visits" — the client tapped
 * "Install the app" on a salon's booking page; the installed app opens here, so it offers to
 * continue in that salon with the same service and specialist. Gone once used or dismissed.
 */
export function ResumeBooking() {
  const { t, locale } = useI18n();
  const [place, setPlace] = useState<BookingPlace | null>(null);

  useEffect(() => {
    setPlace(loadBookingPlace());
  }, []);

  if (!place) return null;
  const b = t.installBanner;

  function forget() {
    clearBookingPlace();
    setPlace(null);
  }

  return (
    <section className="install-app install-app--card resume-booking" data-testid="resume-booking">
      <strong>{b.continueTitle}</strong>
      <p className="small muted">{fill(b.continueLead, { salon: place.salonName })}</p>
      <Link
        className="btn btn--block"
        href={`/${locale}/b/${place.slug}${placeQuery(place)}`}
        onClick={forget}
      >
        {b.continueButton}
      </Link>
      <button type="button" className="link-btn small" onClick={forget}>
        {b.continueDismiss}
      </button>
    </section>
  );
}
