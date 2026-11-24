'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatDay, formatPrice } from '@/lib/time';
import type { WaitlistOffer } from '@/lib/types';
import { FieldError, LanguageSwitch, Spinner } from '../ui';

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
  /**
   * Task 761 (owner's rule: errors where the action is): a refused "Biorę ten termin" or "Nie,
   * dziękuję" is said under the button that was pressed, not at the top of the page. When the
   * offer is no longer open after the refresh, under its status line.
   */
  const [error, setError] = useState<{ kind: 'accept' | 'decline'; text: string } | null>(null);
  /** Task 705 (owner's rule: errors at the field): what is wrong with the phone, under it. */
  const [phoneProblem, setPhoneProblem] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<WaitlistOffer>(`/v1/public/waitlist-offers/${token}`, { auth: false })
      .then(setOffer)
      .catch(() => setMissing(true));
  }, [token]);

  async function answer(kind: 'accept' | 'decline') {
    // Task 705: an empty phone is said under the field (the button was silently switched off).
    if (kind === 'accept' && offer?.needsPhone && !phone.trim()) {
      setError(null);
      setPhoneProblem(t.onboarding.fieldRequired);
      document.getElementById('offer-phone')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setPhoneProblem('');
    try {
      setOffer(
        await api<WaitlistOffer>(`/v1/public/waitlist-offers/${token}/${kind}`, {
          method: 'POST',
          auth: false,
          ...(kind === 'accept' ? { body: phone.trim() ? { phone: phone.trim() } : {} } : {}),
        }),
      );
    } catch (err) {
      // Task 705: a phone the server does not take is said under the phone, not at the top.
      const atPhone =
        err instanceof ApiError &&
        err.code === 'VALIDATION_ERROR' &&
        Array.isArray(err.details) &&
        (err.details as { path?: string }[]).some((d) => d.path === 'phone');
      if (atPhone) {
        setPhoneProblem(t.booking.phoneInvalid);
        document.getElementById('offer-phone')?.focus();
        return;
      }
      setError({ kind, text: errorText(t, err) });
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
            <form
              noValidate
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void answer('accept');
              }}
            >
              <p className="note" role="status">
                {fill(t.waitlist.offerLead, { time: until })}
              </p>
              {offer.needsPhone ? (
                <label className="field">
                  <span>{t.waitlist.offerPhone}</span>
                  <input
                    id="offer-phone"
                    type="tel"
                    autoComplete="tel"
                    placeholder="+48 600 000 000"
                    value={phone}
                    aria-invalid={phoneProblem ? true : undefined}
                    aria-describedby={phoneProblem ? 'offer-phone-error' : undefined}
                    onChange={(e) => {
                      setPhone(e.target.value);
                      setPhoneProblem('');
                    }}
                  />
                  <FieldError id="offer-phone-error" text={phoneProblem} />
                </label>
              ) : null}
              <button
                type="submit"
                className="btn"
                disabled={busy}
                aria-describedby={error?.kind === 'accept' ? 'offer-accept-error' : undefined}
              >
                {t.waitlist.offerTake}
              </button>
              <FieldError
                id="offer-accept-error"
                text={error?.kind === 'accept' ? error.text : undefined}
              />
              <button
                type="button"
                className="btn btn--quiet"
                disabled={busy}
                aria-describedby={error?.kind === 'decline' ? 'offer-decline-error' : undefined}
                onClick={() => void answer('decline')}
              >
                {t.waitlist.offerDecline}
              </button>
              <FieldError
                id="offer-decline-error"
                text={error?.kind === 'decline' ? error.text : undefined}
              />
            </form>
          ) : (
            <>
              <p className="note" role="status">
                {statusText[offer.status] ?? t.waitlist.cancelled}
              </p>
              <FieldError id="offer-error" text={error?.text} />
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
