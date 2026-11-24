'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import type { VisitReview } from '@/lib/types';
import { FieldError } from '../ui';
import { SalonReply } from './SalonReply';
import { StarPicker, Stars } from './Stars';

/**
 * Task 165b: the client's review of a visit that took place — on the visit link (the
 * "How was it?" email opens it at #review) and in "My visits". Hidden when there is
 * nothing to write and nothing written.
 */
/** Which field the server's VALIDATION_ERROR is about ('rating', 'text'), if any. */
function problemPathOf(err: unknown): 'rating' | 'text' | null {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return null;
  if (!Array.isArray(err.details)) return null;
  const paths = (err.details as { path?: unknown }[]).map((d) => String(d.path ?? ''));
  if (paths.includes('rating')) return 'rating';
  if (paths.includes('text')) return 'text';
  return null;
}

export function VisitReviewForm({ endpoint, staffName }: { endpoint: string; staffName: string }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<VisitReview | null>(null);
  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /**
   * Task 684 (owner's rule: errors at the field): "Wyślij opinię" used to stay switched off
   * without a word until a star was chosen; now "Wybierz ocenę." is said under the stars and the
   * focus goes to them. The server's answer about the rating or the text is said at that field.
   */
  const [ratingProblem, setRatingProblem] = useState(false);
  const [textProblem, setTextProblem] = useState('');
  const [thanks, setThanks] = useState(false);
  // The form and "Zmień opinię" take each other's place: once the client has acted, keyboard
  // focus follows — to the chosen star when the form opens, to "Zmień opinię" (or the section)
  // after sending. Not on page load.
  const sectionRef = useRef<HTMLElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const acted = useRef(false);
  useEffect(() => {
    if (!acted.current) return;
    if (editing) {
      const stars = formRef.current;
      const star =
        stars?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]') ??
        stars?.querySelector<HTMLButtonElement>('[role="radio"]');
      star?.focus();
    } else if (changeRef.current) changeRef.current.focus();
    else sectionRef.current?.focus();
  }, [editing]);

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
    acted.current = true;
    setBusy(true);
    setError('');
    setRatingProblem(false);
    setTextProblem('');
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
      const path = problemPathOf(err);
      if (path === 'rating') setRatingProblem(true);
      else if (path === 'text') setTextProblem(errorText(t, err));
      else setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      id="review"
      className="section review-form"
      aria-label={t.reviews.yours}
      ref={sectionRef}
      tabIndex={-1}
    >
      <h2 className="h3">{t.reviews.yours}</h2>
      {thanks ? (
        <p className="note" role="status">
          {t.reviews.thanks}
        </p>
      ) : null}
      {editing ? (
        <form
          className="form"
          ref={formRef}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (rating > 0) {
              void save();
              return;
            }
            setError('');
            setRatingProblem(true);
            e.currentTarget.querySelector<HTMLButtonElement>('[role="radio"]')?.focus();
          }}
        >
          <p>{fill(t.reviews.ask, { staff: staffName })}</p>
          <div className="stack" style={{ gap: 2 }}>
            <StarPicker
              value={rating}
              invalid={ratingProblem}
              describedBy={ratingProblem ? 'review-rating-error' : undefined}
              onChange={(n) => {
                setRating(n);
                setRatingProblem(false);
                setError('');
              }}
            />
            <FieldError
              id="review-rating-error"
              text={ratingProblem ? t.reviews.ratingRequired : undefined}
            />
          </div>
          <label className="field">
            <span>{t.reviews.text}</span>
            <textarea
              value={text}
              maxLength={1000}
              aria-invalid={textProblem ? true : undefined}
              aria-describedby={textProblem ? 'review-text-error' : undefined}
              onChange={(e) => {
                setText(e.target.value);
                setTextProblem('');
                setError('');
              }}
            />
            <FieldError id="review-text-error" text={textProblem || undefined} />
          </label>
          {/* Task 772 (owner's rule: errors where the action is): a refusal that is not about the
              stars or the text is said under "Wyślij opinię", with the "!" mark. */}
          <button
            className="btn btn--primary btn--block"
            disabled={busy}
            aria-describedby={error ? 'review-send-error' : undefined}
          >
            {t.reviews.send}
          </button>
          <FieldError id="review-send-error" text={error || undefined} />
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
              <button
                type="button"
                className="btn btn--quiet"
                ref={changeRef}
                onClick={() => {
                  acted.current = true;
                  setEditing(true);
                }}
              >
                {t.reviews.change}
              </button>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
