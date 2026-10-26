'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import type { ClientAppointment } from '@/lib/types';
import { AppointmentManager } from '../booking/ManageAppointment';
import { bookAgainHref } from './ClientVisits';

/** One visit in the "My visits" app: move, cancel, book again. */
export function ClientVisit({ id }: { id: string }) {
  const { t, locale } = useI18n();
  return (
    <AppointmentManager<ClientAppointment>
      endpoint={`/v1/client/appointments/${id}`}
      title={t.visits.title}
      top={
        <Link className="link-btn small" href={`/${locale}/c`}>
          ← {t.visits.allVisits}
        </Link>
      }
      extra={(a) => {
        const href = bookAgainHref(locale, a);
        return href ? (
          <Link className="btn btn--quiet btn--block" href={href}>
            {t.visits.bookAgain}
          </Link>
        ) : null;
      }}
    />
  );
}
