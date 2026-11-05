'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatDay, formatPrice } from '@/lib/time';
import type { WaitlistOffer } from '@/lib/types';
import { ErrorBox, LanguageSwitch, Spinner } from '../ui';

/**
 * Task 164: a freed time is held for the first client on the waiting list for 15 minutes.
 * The client takes it (a phone number if the list had none) or says no; then the next one gets it.
 */
export function WaitlistOfferView({ token }: { token: string }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [offer, setOffer] = useState<WaitlistOffer | null>(null);
  const [missing, setMissing] = useState(false);
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<WaitlistOffer>(`/v1/public/waitlist-offers/${token}`, { auth: false })
      .then(setOffer)
      .catch(() => setMissing(true));
  }, [token]);

  async function answer(kind: 'accept' | 'decline') {
    setBusy(true);
    setError('');
    try {
      setOffer(
        await api<WaitlistOffer>(`/v1/public/waitlist-offers/${token}/${kind}`, {
          method: 'POST',
          auth: false,
          ...(kind === 'accept' ? { body: phone.trim() ? { phone: phone.trim() } : {} } : {}),
        }),
      );
    } catch (err) {
      setError(errorText(t, err));
      // The time may be gone meanwhile: show what it is now.
      api<WaitlistOffer>(`/v1/public/waitlist-offers/${token}`, { auth: false })
        .then(setOffer)
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  if (missing) {
    return (
      <div className="narrow stack">
        <p className="note">{t.errors.NOT_FOUND}</p>
      </div>
    );
  }
  if (!offer) return <Spinner />;

  const until = offer.expiresAt
    ? new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit' }).format(
        new Date(offer.expiresAt),
      )
    : '';
  const statusText: Partial<Record<WaitlistOffer['status'], string>> = {
    booked: t.waitlist.offerBooked,
    declined: t.waitlist.declined,
    missed: t.waitlist.missed,
    cancelled: t.waitlist.cancelled,
  };
  return (
    <div className="booking">
      <header className="salon-head">
        <div className="salon-head-inner">
          <div className="top">
            <span className="small muted">{t.waitlist.title}</span>
            <LanguageSwitch />
          </div>
          <h1 className="salon-name">{offer.salon.name}</h1>
        </div>
      </header>
      <main className="narrow stack">
        <ErrorBox>{error}</ErrorBox>
        <section className="stack" aria-label={t.waitlist.offerTitle}>
          <h2>{t.waitlist.offerTitle}</h2>
          <p>
            <strong>{offer.serviceName}</strong>
            {offer.staffName ? ` · ${offer.staffName}` : ''}
          </p>
          <p>
            {formatDay(offer.date, tag)}
            {offer.time ? `, ${offer.time}` : ''}
            {offer.durationMinutes ? ` · ${offer.durationMinutes} ${t.common.minutes}` : ''}
            {offer.priceGrosze !== null
              ? ` · ${formatPrice(offer.priceGrosze, offer.currency, tag)}`
              : ''}
          </p>
          {offer.status === 'offered' ? (
            <>
              <p className="note" role="status">
                {fill(t.waitlist.offerLead, { time: until })}
              </p>
              {offer.needsPhone ? (
                <label className="field">
                  <span>{t.waitlist.offerPhone}</span>
                  <input
                    type="tel"
                    autoComplete="tel"
                    placeholder="+48 600 000 000"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </label>
              ) : null}
              <button
                type="button"
                className="btn"
                disabled={busy || (offer.needsPhone && !phone.trim())}
                onClick={() => void answer('accept')}
              >
                {t.waitlist.offerTake}
              </button>
              <button
                type="button"
                className="btn btn--quiet"
                disabled={busy}
                onClick={() => void answer('decline')}
              >
                {t.waitlist.offerDecline}
              </button>
            </>
          ) : (
            <>
              <p className="note" role="status">
                {statusText[offer.status] ?? t.waitlist.cancelled}
              </p>
              {offer.status !== 'booked' ? (
                <a
                  className="btn"
                  href={`/${locale}/b/${offer.salon.slug}?${new URLSearchParams({ service: offer.serviceId })}`}
                >
                  {t.waitlist.book}
                </a>
              ) : null}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
