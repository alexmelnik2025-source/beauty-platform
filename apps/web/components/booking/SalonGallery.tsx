'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fill, useI18n } from '@/lib/i18n';
import type { PublicLocation } from '@/lib/types';

/**
 * Salon photos on the booking page: a strip that scrolls sideways; a tap opens the photo
 * full screen. Arrows (and ← →) go through the photos, Escape or a tap beside the photo closes.
 */
export function SalonGallery({ photos }: { photos: PublicLocation['photos'] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  const thumbs = useRef<(HTMLButtonElement | null)[]>([]);
  const closeRef = useRef<HTMLButtonElement>(null);
  const count = photos.length;

  const openRef = useRef<number | null>(null);
  openRef.current = open;

  const close = useCallback(() => {
    const current = openRef.current;
    setOpen(null);
    // Back to the photo the client opened, for keyboard users.
    if (current !== null) thumbs.current[current]?.focus();
  }, []);
  const step = useCallback(
    (by: number) =>
      setOpen((current) => (current === null ? null : (current + by + count) % count)),
    [count],
  );

  const isOpen = open !== null;
  useEffect(() => {
    if (!isOpen) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [isOpen, close, step]);

  if (count === 0) return null;
  const index = open ?? 0;
  const shown = open === null ? undefined : photos[open];

  return (
    <>
      <ul
        className={count === 1 ? 'salon-photos salon-photos--single' : 'salon-photos'}
        aria-label={t.photos.title}
      >
        {photos.map((p, i) => (
          <li key={p.id}>
            <button
              type="button"
              ref={(el) => {
                thumbs.current[i] = el;
              }}
              onClick={() => setOpen(i)}
            >
              <img
                src={p.url}
                alt={`${t.photos.alt} ${i + 1}`}
                loading={i < 2 ? 'eager' : 'lazy'}
                decoding="async"
              />
            </button>
          </li>
        ))}
      </ul>

      {shown ? (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={t.photos.title}
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <img
            key={shown.id}
            src={shown.url}
            alt={fill(t.photos.position, { n: String(index + 1), count: String(count) })}
          />
          <button
            type="button"
            className="lightbox-btn lightbox-close"
            ref={closeRef}
            onClick={close}
            aria-label={t.common.close}
          >
            ✕
          </button>
          {count > 1 ? (
            <>
              <button
                type="button"
                className="lightbox-btn lightbox-prev"
                onClick={() => step(-1)}
                aria-label={t.photos.previous}
              >
                ‹
              </button>
              <button
                type="button"
                className="lightbox-btn lightbox-next"
                onClick={() => step(1)}
                aria-label={t.photos.next}
              >
                ›
              </button>
            </>
          ) : null}
          <p className="lightbox-count small" aria-hidden="true">
            {index + 1} / {count}
          </p>
        </div>
      ) : null}
    </>
  );
}
