'use client';

import { useState } from 'react';
import { fill, useI18n } from '@/lib/i18n';

/**
 * Task 406: "Poleć salon znajomym" on a salon page — the phone's share sheet (WhatsApp, Messenger,
 * SMS) with the salon's booking link; where the browser cannot share, the link is copied.
 */
export function ShareSalon({ name, slug }: { name: string; slug: string }) {
  const { t, locale } = useI18n();
  const [info, setInfo] = useState('');

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
      {info ? (
        <span className="small muted" role="status">
          {info}
        </span>
      ) : null}
    </div>
  );
}
