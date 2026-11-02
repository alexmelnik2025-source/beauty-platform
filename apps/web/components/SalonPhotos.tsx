'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';
import { MAX_SALON_PHOTOS, PHOTO_ACCEPT, SALON_PHOTO_SIDE, shrinkPhoto } from '@/lib/photos';
import type { Photo } from '@/lib/types';
import { ErrorBox } from './ui';

/** Salon photos for the booking page: add (shrunk in the browser first) and remove. */
export function SalonPhotos({ base }: { base: string }) {
  const { t } = useI18n();
  const url = `${base}/photos`;
  const input = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Photo[]>(url)
      .then(setPhotos)
      .catch((err) => setError(errorText(t, err)));
  }, [url, t]);

  async function add(files: FileList | null) {
    if (!files?.length || !photos) return;
    setBusy(true);
    setError('');
    let list = photos;
    try {
      for (const file of Array.from(files).slice(0, MAX_SALON_PHOTOS - list.length)) {
        const blob = await shrinkPhoto(file, SALON_PHOTO_SIDE);
        const saved = await api<Photo>(url, { method: 'POST', file: blob });
        list = [...list, saved];
        setPhotos(list);
      }
      if (files.length > MAX_SALON_PHOTOS - photos.length) setError(t.errors.TOO_MANY_PHOTOS);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove(id: string) {
    setError('');
    try {
      await api(`${url}/${id}`, { method: 'DELETE' });
      setPhotos((list) => list && list.filter((p) => p.id !== id));
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  const full = (photos?.length ?? 0) >= MAX_SALON_PHOTOS;
  return (
    <section className="section">
      <h2>{t.photos.title}</h2>
      <p className="small muted">{t.photos.hint}</p>
      <ErrorBox>{error}</ErrorBox>
      {photos?.length ? (
        <ul className="photo-grid">
          {photos.map((p, i) => (
            <li key={p.id}>
              <img src={p.url} alt={`${t.photos.alt} ${i + 1}`} />
              <button
                type="button"
                className="icon-btn photo-remove"
                aria-label={`${t.photos.remove} ${i + 1}`}
                onClick={() => void remove(p.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row" style={{ alignItems: 'center' }}>
        <label className={`btn btn--quiet${busy || full || !photos ? ' is-disabled' : ''}`}>
          {busy ? t.photos.uploading : t.photos.add}
          <input
            ref={input}
            type="file"
            accept={PHOTO_ACCEPT}
            multiple
            className="visually-hidden"
            disabled={busy || full || !photos}
            aria-label={t.photos.add}
            onChange={(e) => void add(e.target.files)}
          />
        </label>
        <span className="small muted" role="status">
          {t.photos.count
            .replace('{count}', String(photos?.length ?? 0))
            .replace('{max}', String(MAX_SALON_PHOTOS))}
        </span>
      </div>
    </section>
  );
}
