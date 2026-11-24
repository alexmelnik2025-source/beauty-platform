'use client';

import { useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';
import { PHOTO_ACCEPT, SALON_PHOTO_SIDE, shrinkPhoto } from '@/lib/photos';
import type { Hold, VisitPhoto } from '@/lib/types';
import { FieldError } from '../ui';

/** At most this many example photos per visit (the API checks it too). */
export const MAX_WISH_PHOTOS = 3;

/**
 * Task 80b/80f: "Pokaż, co chcesz" on the code step — up to 3 example photos (a haircut from
 * Instagram…), made smaller in the browser and added to the held time; they stay with the
 * visit once it is confirmed. Only for services where the salon switched it on.
 */
export function WishPhotos({ hold }: { hold: Pick<Hold, 'holdId' | 'holdToken'> }) {
  const { t } = useI18n();
  const w = t.wishStep;
  const [photos, setPhotos] = useState<VisitPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  /**
   * Task 782 (owner's rule: errors where the action is): a refused "Usuń" is said under that
   * photo; a refused or too many "+ Dodaj zdjęcie" under that button — with the "!", not a box.
   * `on` is the photo's id, or `add`.
   */
  const [error, setError] = useState<{ on: string; text: string } | null>(null);
  const errorOn = (on: string) => (error?.on === on ? error.text : undefined);
  const errorId = (on: string) => `wish-photo-${on}-error`;
  const input = useRef<HTMLInputElement>(null);
  const headers = { 'X-Hold-Token': hold.holdToken };

  function problem(err: unknown): string {
    if (err instanceof ApiError && err.code === 'TOO_MANY_PHOTOS') return w.photosTooMany;
    return errorText(t, err);
  }

  async function add(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      let count = photos.length;
      for (const file of Array.from(files)) {
        if (count >= MAX_WISH_PHOTOS) {
          setError({ on: 'add', text: w.photosTooMany });
          break;
        }
        const blob = await shrinkPhoto(file, SALON_PHOTO_SIDE);
        const saved = await api<VisitPhoto>(`/v1/public/holds/${hold.holdId}/photos`, {
          method: 'POST',
          file: blob,
          headers,
          auth: false,
        });
        count += 1;
        setPhotos((list) => [...list, saved]);
      }
    } catch (err) {
      setError({ on: 'add', text: problem(err) });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/public/holds/${hold.holdId}/photos/${id}`, {
        method: 'DELETE',
        headers,
        auth: false,
      });
      setPhotos((list) => list.filter((p) => p.id !== id));
    } catch (err) {
      setError({ on: id, text: problem(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wishes-step" aria-labelledby="wish-photos-title">
      <h3 id="wish-photos-title">📷 {w.photosQ}</h3>
      <p className="muted small">{w.photosLead}</p>
      {photos.length > 0 ? (
        <ul className="wish-photos" aria-label={w.photosQ}>
          {photos.map((p, i) => (
            <li key={p.id} className="wish-photos__item">
              <img src={p.url} alt={w.photoAlt.replace('{n}', String(i + 1))} />
              <button
                type="button"
                className="link-btn small"
                disabled={busy}
                aria-label={`${w.photosRemove}: ${w.photoAlt.replace('{n}', String(i + 1))}`}
                aria-describedby={errorOn(p.id) ? errorId(p.id) : undefined}
                onClick={() => void remove(p.id)}
              >
                {w.photosRemove}
              </button>
              <FieldError id={errorId(p.id)} text={errorOn(p.id)} />
            </li>
          ))}
        </ul>
      ) : null}
      {photos.length < MAX_WISH_PHOTOS ? (
        <label className={`btn btn--quiet btn--small${busy ? ' is-busy' : ''}`}>
          {busy ? w.photosUploading : w.photosAdd}
          <input
            ref={input}
            type="file"
            accept={PHOTO_ACCEPT}
            multiple
            hidden
            disabled={busy}
            aria-describedby={errorOn('add') ? errorId('add') : undefined}
            onChange={(e) => void add(e.target.files)}
          />
        </label>
      ) : null}
      <FieldError id={errorId('add')} text={errorOn('add')} />
    </section>
  );
}
