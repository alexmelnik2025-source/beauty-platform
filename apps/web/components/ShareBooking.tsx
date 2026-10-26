'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';

/** Short link (Instagram bio, business card) and the booking button for the salon's own site. */
export function ShareBooking({ slug }: { slug: string }) {
  const { t, locale } = useI18n();
  const origin = window.location.origin;
  const shortLink = `${origin}/s/${slug}`;
  const embedCode = `<script src="${origin}/embed.js" data-salon="${slug}" data-lang="${locale}" async></script>`;
  return (
    <section className="section">
      <h2>{t.share.title}</h2>
      <div className="field">
        <span id="share-short">{t.share.shortLink}</span>
        <CopyField value={shortLink} labelledBy="share-short" />
        <small className="muted">{t.share.shortHint}</small>
      </div>
      <div className="field">
        <span id="share-embed">{t.share.embed}</span>
        <CopyField value={embedCode} labelledBy="share-embed" multiline />
        <small className="muted">{t.share.embedHint}</small>
        <small className="muted">{t.share.ownButton}</small>
      </div>
    </section>
  );
}

function CopyField({
  value,
  labelledBy,
  multiline = false,
}: {
  value: string;
  labelledBy: string;
  multiline?: boolean;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className={multiline ? 'copy-field copy-field--code' : 'copy-field'}>
      {multiline ? (
        <textarea
          readOnly
          value={value}
          aria-labelledby={labelledBy}
          onFocus={(e) => e.target.select()}
        />
      ) : (
        <input
          className="input"
          readOnly
          value={value}
          aria-labelledby={labelledBy}
          onFocus={(e) => e.target.select()}
        />
      )}
      <button
        type="button"
        className="btn btn--quiet"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
        }}
      >
        {copied ? t.actions.copied : t.actions.copy}
      </button>
    </div>
  );
}
