'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Wordmark } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { ClientPerson } from '@/lib/types';

/**
 * The client's way around the site (task 180, owner's note 05.11): on the home page, the salon
 * catalogue, a salon's booking page and "My visits" — "Znajdź salon" and "Moje wizyty", or
 * "Zaloguj się · bez hasła — kod na e-mail" when the client has not signed in on this device.
 */
export function ClientNav({ current }: { current?: 'salons' | 'visits' }) {
  const { t, locale } = useI18n();
  const n = t.clientNav;
  // Unknown until the API answers: the link then reads "Moje wizyty" (the page it opens).
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    api<ClientPerson>('/v1/client/me', { auth: false })
      .then(() => alive && setSignedIn(true))
      .catch(() => alive && setSignedIn(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <nav className="client-nav" aria-label={n.label}>
      <Wordmark />
      <div className="client-nav-links">
        <Link
          href={`/${locale}/salons`}
          aria-current={current === 'salons' ? 'page' : undefined}
          className="client-nav-link"
        >
          {n.findSalon}
        </Link>
        <Link
          href={`/${locale}/c`}
          aria-current={current === 'visits' ? 'page' : undefined}
          className="client-nav-link"
        >
          {signedIn === false ? (
            <>
              {n.signIn} <small className="client-nav-hint">{n.signInHint}</small>
            </>
          ) : (
            n.myVisits
          )}
        </Link>
      </div>
    </nav>
  );
}
