'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { OpenNow } from '@/components/OpenNow';
import { api, ApiError } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';
import type { ClientFavorites as Favorites, FavoriteSalon } from '@/lib/types';
import { ErrorBox, Spinner } from '../ui';

/**
 * Task 404: "Ulubione" in "Moje wizyty" on the site, as in the client app (task 61): the saved
 * salons, newest first, with "Otwarte teraz", "Umów wizytę" and "Usuń z ulubionych". A salon
 * that stopped online booking stays on the list, greyed out.
 */
export function ClientFavorites({ onSignedOut }: { onSignedOut: () => void }) {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<FavoriteSalon[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api<Favorites>('/v1/client/favorites', { auth: false })
      .then((res) => setItems(res.items))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) onSignedOut();
        else setError(errorText(t, err));
      });
  }, [t, onSignedOut]);

  async function remove(slug: string) {
    setBusy(slug);
    setError('');
    try {
      await api(`/v1/client/favorites/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
        auth: false,
      });
      setItems((list) => (list ?? []).filter((s) => s.slug !== slug));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  }

  if (items === null) return error ? <ErrorBox>{error}</ErrorBox> : <Spinner />;
  return (
    <section className="stack" aria-label={t.favorites.tab}>
      <ErrorBox>{error}</ErrorBox>
      {items.length === 0 ? <p className="note">{t.favorites.empty}</p> : null}
      <ul className="list">
        {items.map((salon) => (
          <li key={salon.slug} data-bookable={salon.bookable ? undefined : 'false'}>
            <article className="stack directory-salon grow" aria-label={salon.name}>
              <h2>
                <Link href={`/${locale}/b/${salon.slug}`}>{salon.name}</Link>
              </h2>
              <span className="muted small">
                {salon.addressLine}, {salon.postalCode} {salon.city}
              </span>
              {salon.bookable ? (
                <OpenNow salon={salon} />
              ) : (
                <span className="small muted">{t.favorites.notBookable}</span>
              )}
              <div className="row">
                {salon.bookable ? (
                  <Link className="btn btn--small" href={`/${locale}/b/${salon.slug}`}>
                    {t.directory.book}
                  </Link>
                ) : null}
                <button
                  type="button"
                  className="btn btn--quiet btn--small"
                  aria-label={`${t.favorites.remove}: ${salon.name}`}
                  disabled={busy === salon.slug}
                  onClick={() => void remove(salon.slug)}
                >
                  {t.favorites.remove}
                </button>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
