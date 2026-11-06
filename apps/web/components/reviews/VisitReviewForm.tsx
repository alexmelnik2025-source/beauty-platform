'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import type { VisitReview } from '@/lib/types';
import { ErrorBox } from '../ui';
import { SalonReply } from './SalonReply';
import { StarPicker, Stars } from './Stars';

/**
 * Task 165b: the client's review of a visit that took place — on the visit link (the
 * "How was it?" email opens it at #review) and in "My visits". Hidden when there is
 * nothing to write and nothing written.
 */
export function VisitReviewForm({ endpoint, staffName }: { endpoint: string; staffName: string }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<VisitReview | null>(null);
  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    api<VisitReview>(endpoint, { auth: false })
      .then((res) => {
        setState(res);
        setEditing(res.canReview && !res.review);
        setRating(res.review?.rating ?? 0);
        setText(res.review?.text ?? '');
      })
      .catch(() => setState(null));
  }, [endpoint]);

  useEffect(() => {
    if (state?.canReview && window.location.hash === '#review') {
      document.getElementById('review')?.scrollIntoView({ block: 'center' });
    }
  }, [state]);

  if (!state || (!state.canReview && !state.review)) return null;

  const until = state.reviewUntil
    ? new Intl.DateTimeFormat(LOCALE_TAGS[locale], { day: 'numeric', month: 'long' }).format(
        new Date(state.reviewUntil),
      )
    : null;

  async function save() {
    setBusy(true);
    setError('');
    try {
      const res = await api<VisitReview>(endpoint, {
        method: 'PUT',
        auth: false,
        body: { rating, text },
      });
      setState(res);
      setEditing(false);
      setThanks(true);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="review" className="section review-form" aria-label={t.reviews.yours}>
      <h2 className="h3">{t.reviews.yours}</h2>
      {thanks ? (
        <p className="note" role="status">
          {t.reviews.thanks}
        </p>
      ) : null}
      {editing ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (rating > 0) void save();
          }}
        >
          <p>{fill(t.reviews.ask, { staff: staffName })}</p>
          <StarPicker value={rating} onChange={setRating} />
          <label className="field">
            <span>{t.reviews.text}</span>
            <textarea value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} />
          </label>
          <ErrorBox>{error}</ErrorBox>
          <button className="btn btn--primary btn--block" disabled={busy || rating === 0}>
            {t.reviews.send}
          </button>
        </form>
      ) : state.review ? (
        <>
          <Stars value={state.review.rating} />
          {state.review.text ? <p className="review-text">{state.review.text}</p> : null}
          <SalonReply text={state.review.reply} />
          {state.canReview ? (
            <>
              {until ? (
                <p className="small muted">{fill(t.reviews.changeUntil, { date: until })}</p>
              ) : null}
              <button type="button" className="btn btn--quiet" onClick={() => setEditing(true)}>
                {t.reviews.change}
              </button>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
