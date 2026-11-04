'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import type { PublicLegalTexts } from '@/lib/types';
import { Markdown } from '../Markdown';
import { ErrorBox, Spinner } from '../ui';

/** The salon's booking terms or privacy policy, linked from the consent checkbox. */
export function LegalPage({ slug, doc }: { slug: string; doc: 'terms' | 'privacy' }) {
  const { t, locale } = useI18n();
  const [texts, setTexts] = useState<PublicLegalTexts | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<PublicLegalTexts>(`/v1/public/locations/${encodeURIComponent(slug)}/legal`)
      .then(setTexts)
      .catch((err) =>
        setError(
          err instanceof ApiError && err.status === 404 ? t.booking.salonClosed : errorText(t, err),
        ),
      );
  }, [slug, t]);

  const title = doc === 'terms' ? t.legal.terms : t.legal.privacy;
  const back = (
    <Link className="btn btn--quiet" href={`/${locale}/b/${slug}`}>
      {t.legal.back}
    </Link>
  );
  if (error) {
    return (
      <div className="narrow">
        <ErrorBox>{error}</ErrorBox>
      </div>
    );
  }
  if (!texts) return <Spinner />;
  const text = doc === 'terms' ? texts.bookingTerms : texts.privacyPolicy;
  const updated = new Intl.DateTimeFormat(LOCALE_TAGS[locale], { dateStyle: 'long' }).format(
    new Date(texts.updatedAt),
  );
  return (
    <main className="narrow legal-page">
      {back}
      <p className="muted small">
        {texts.name} · {title}
      </p>
      {text ? <Markdown source={text} /> : <p className="note">{t.legal.notWritten}</p>}
      {text ? <p className="muted small">{fill(t.legal.updated, { date: updated })}</p> : null}
      {back}
    </main>
  );
}
