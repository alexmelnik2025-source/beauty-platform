'use client';

import { useEffect, useId, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';
import type { ClientFavorites } from '@/lib/types';
import { FieldError } from '../ui';

/**
 * Task 405: "♡ Dodaj do ulubionych" / "♥ W ulubionych" on a salon page for a client signed in to
 * "Moje wizyty" on this device — the same list as "Ulubione" (site and client app).
 */
export function FavoriteButton({
  slug,
  className = 'btn btn--quiet btn--small',
}: {
  slug: string;
  /** Task Q5: a quiet text link on the "Do zobaczenia!" screen. */
  className?: string;
}) {
  const { t } = useI18n();
  // null = not known yet: no button.
  const [saved, setSaved] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Task 778 (owner's rule: errors where the action is): a refusal is said right under the heart
   * with its "!" and read with the button, not as a box.
   */
  const [error, setError] = useState('');
  const errorId = `${useId()}-favorite-error`;

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
        className={className}
        aria-label={saved ? t.favorites.remove : t.favorites.add}
        disabled={busy}
        aria-describedby={error ? errorId : undefined}
        onClick={() => void toggle()}
      >
        {saved ? t.favorites.saved : t.favorites.add}
      </button>
      <FieldError id={errorId} text={error} />
    </div>
  );
}
