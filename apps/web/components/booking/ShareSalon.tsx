'use client';

import { useMemo, useState } from 'react';
import { fill, useI18n } from '@/lib/i18n';
import { encodeQr, qrSvg } from '@/lib/qr';

/**
 * Task 406: "Poleć salon znajomym" on a salon page — the phone's share sheet (WhatsApp, Messenger,
 * SMS) with the salon's booking link; where the browser cannot share, the link is copied.
 * Task 409: "Pokaż kod QR" — a friend next to you scans the page with the phone's camera.
 */
export function ShareSalon({ name, slug }: { name: string; slug: string }) {
  const { t, locale } = useI18n();
  const [info, setInfo] = useState('');
  const [qrOpen, setQrOpen] = useState(false);
  // The link is only known in the browser (its own address).
  const svg = useMemo(
    () =>
      qrOpen
        ? qrSvg(encodeQr(`${window.location.origin}/${locale}/b/${slug}`), t.shareSalon.qrAlt)
        : '',
    [qrOpen, locale, slug, t.shareSalon.qrAlt],
  );

  async function share() {
    const url = `${window.location.origin}/${locale}/b/${slug}`;
    const text = fill(t.shareSalon.shareText, { name, url });
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: name, text, url });
        setInfo('');
        return;
      }
      await navigator.clipboard.writeText(url);
      setInfo(t.shareSalon.copied);
    } catch (err) {
      // The client closed the share sheet: nothing to say.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setInfo(fill(t.shareSalon.shareFailed, { url }));
    }
  }

  return (
    <div className="share-salon">
      <button type="button" className="btn btn--quiet btn--small" onClick={() => void share()}>
        {t.shareSalon.share}
      </button>
      <button
        type="button"
        className="btn btn--quiet btn--small"
        aria-expanded={qrOpen}
        onClick={() => setQrOpen(!qrOpen)}
      >
        {qrOpen ? t.shareSalon.qrHide : t.shareSalon.qrShow}
      </button>
      {info ? (
        <span className="small muted" role="status">
          {info}
        </span>
      ) : null}
      {qrOpen ? (
        <figure className="share-salon-qr">
          {/* The SVG carries its own name (<title>): one image for screen readers. */}
          <div className="share-salon-qr-code" dangerouslySetInnerHTML={{ __html: svg }} />
          <figcaption>
            <strong>{name}</strong>
            <span className="small muted">{t.shareSalon.qrHint}</span>
          </figcaption>
        </figure>
      ) : null}
    </div>
  );
}
