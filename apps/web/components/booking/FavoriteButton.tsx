'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';
import type { ClientFavorites } from '@/lib/types';
import { ErrorBox } from '../ui';

/**
 * Task 405: "♡ Dodaj do ulubionych" / "♥ W ulubionych" on a salon page for a client signed in to
 * "Moje wizyty" on this device — the same list as "Ulubione" (site and client app).
 */
export function FavoriteButton({ slug }: { slug: string }) {
  const { t } = useI18n();
  // null = not known yet: no button.
  const [saved, setSaved] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api<ClientFavorites>('/v1/client/favorites', { auth: false })
      .then((res) => live && setSaved(res.items.some((s) => s.slug === slug)))
      .catch(() => live && setSaved(null));
    return () => {
      live = false;
    };
  }, [slug]);

  if (saved === null) return null;

  async function toggle() {
    setBusy(true);
    setError('');
    try {
      await api(`/v1/client/favorites/${encodeURIComponent(slug)}`, {
        method: saved ? 'DELETE' : 'PUT',
        auth: false,
      });
      setSaved(!saved);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'TOO_MANY_FAVORITES'
          ? t.favorites.tooMany
          : errorText(t, err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="favorite-button">
      <button
        type="button"
        className="btn btn--quiet btn--small"
        aria-label={saved ? t.favorites.remove : t.favorites.add}
        disabled={busy}
        onClick={() => void toggle()}
      >
        {saved ? t.favorites.saved : t.favorites.add}
      </button>
      <ErrorBox>{error}</ErrorBox>
    </div>
  );
}
