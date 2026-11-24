'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@/components/Session';
import { SalonReply } from '@/components/reviews/SalonReply';
import { StarFilter } from '@/components/reviews/StarFilter';
import { Stars } from '@/components/reviews/Stars';
import { ErrorBox, FieldError, Spinner } from '@/components/ui';
import { api, ApiError, apiResponse } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { useSubmitLock } from '@/lib/submit-lock';
import type { ReviewSettings, SalonReviews } from '@/lib/types';

type Review = SalonReviews['items'][number];

const HOURS = [1, 2, 3, 6, 12, 24, 48, 72];

/**
 * Task 165b: "Opinie" — the owner and managers switch reviews on and choose when the client is
 * asked ("Jak było?" email); everyone sees the reviews with the client's name (staff only those
 * of their own visits — the server decides). Task 211: the owner and managers answer a review
 * publicly, change or remove the answer. Task 380: "★ 1 (2)" chips — e.g. only the low ratings.
 * Task 382: "Bez odpowiedzi (n)" — only the reviews the salon has not answered yet. Task 383:
 * "Kasia ★ 4,8 (12)" chips — only the reviews of one specialist. Task 385: "Pobierz CSV" of the
 * reviews shown (owner and managers). Task 420: "Broda ★ 4,5 (6)" chips — only the reviews of
 * visits for one service (of the chosen specialist, if any).
 */
export default function ReviewsPage() {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const { orgId, location, role } = useSession();
  const base = `/v1/organizations/${orgId}/locations/${location.id}`;
  const manager = role !== 'staff';
  const [list, setList] = useState<SalonReviews | null>(null);
  const [error, setError] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [unanswered, setUnanswered] = useState(false);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  /**
   * Task 731 (owner's rule: errors where the action is): a failed "Pobierz CSV opinii" is said
   * under that button and a failed "Pokaż więcej" under that button — not as a line at the top of
   * the list, far from the button on a phone. "Pokaż więcej" is off while it loads, so a second tap
   * no longer adds the same reviews twice.
   */
  const [csvError, setCsvError] = useState('');
  const [moreError, setMoreError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  /** Task 385: the reviews with the chosen filters as a CSV file (column names in the cabinet language). */
  async function exportCsv(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    setCsvError('');
    try {
      const lang = (['pl', 'uk', 'ru', 'en'] as const).find((l) => l === locale) ?? 'pl';
      const res = await apiResponse(`${base}/reviews/export.csv`, {
        query: {
          lang,
          staffId: staffId ?? undefined,
          serviceId: serviceId ?? undefined,
          rating: rating ?? undefined,
          unanswered: unanswered ? 'true' : undefined,
        },
      });
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ??
        'opinie.csv';
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await res.blob());
      link.download = name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (err) {
      setCsvError(errorText(t, err));
    } finally {
      setExporting(false);
    }
  }

  const load = useCallback(async () => {
    setCsvError('');
    setMoreError('');
    try {
      setList(
        await api<SalonReviews>(`${base}/reviews`, {
          query: {
            staffId: staffId ?? undefined,
            serviceId: serviceId ?? undefined,
            rating: rating ?? undefined,
            unanswered: unanswered ? 'true' : undefined,
          },
        }),
      );
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [base, t, rating, unanswered, staffId, serviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function more() {
    if (!list?.nextBefore || loadingMore) return;
    setLoadingMore(true);
    setMoreError('');
    try {
      const next = await api<SalonReviews>(`${base}/reviews`, {
        query: {
          before: list.nextBefore,
          staffId: staffId ?? undefined,
          serviceId: serviceId ?? undefined,
          rating: rating ?? undefined,
          unanswered: unanswered ? 'true' : undefined,
        },
      });
      setList({ ...next, items: [...list.items, ...next.items] });
    } catch (err) {
      setMoreError(errorText(t, err));
    } finally {
      setLoadingMore(false);
    }
  }

  const one = new Intl.NumberFormat(tag, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const day = (iso: string) =>
    new Intl.DateTimeFormat(tag, {
      timeZone: location.timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(iso));

  return (
    <>
      <div className="page-head">
        <h1>{t.reviewsCabinet.title}</h1>
      </div>
      <div className="page stack">
        {manager ? <ReviewSettingsForm base={base} onSaved={() => void load()} /> : null}
        <ErrorBox>{error}</ErrorBox>
        {list === null ? (
          error ? null : (
            <Spinner />
          )
        ) : (
          <section className="section" aria-label={t.reviewsCabinet.list}>
            <h2>{t.reviewsCabinet.list}</h2>
            {manager && list.count > 0 ? (
              <div className="row">
                <button
                  type="button"
                  className="btn btn--quiet"
                  disabled={exporting}
                  aria-describedby={csvError ? 'reviews-csv-error' : undefined}
                  onClick={() => void exportCsv()}
                >
                  {t.reviewsCabinet.csv}
                </button>
              </div>
            ) : null}
            <FieldError id="reviews-csv-error" text={csvError} />
            {list.average !== null ? (
              <p>
                <Stars value={list.average} />{' '}
                {fill(t.reviews.summary, {
                  avg: one.format(list.average),
                  count: String(list.count),
                })}
              </p>
            ) : null}
            {list.staff.length > 1 ? (
              <div className="chips" role="group" aria-label={t.reviews.bySpecialist}>
                {[
                  { staffId: null, label: t.reviews.everyone },
                  ...list.staff.map((s) => ({
                    staffId: s.staffId,
                    label: `${s.displayName} ★ ${s.average === null ? '' : one.format(s.average)} (${s.count})`,
                  })),
                ].map((chip) => (
                  <button
                    key={chip.staffId ?? 'all'}
                    type="button"
                    aria-pressed={staffId === chip.staffId}
                    onClick={() => {
                      setStaffId(chip.staffId);
                      setRating(null);
                    }}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            ) : null}
            {list.services.length > 1 || serviceId !== null ? (
              <div className="chips" role="group" aria-label={t.reviews.byService}>
                {[
                  { serviceId: null, label: t.reviews.allServices },
                  ...list.services.map((s) => ({
                    serviceId: s.serviceId,
                    label: `${s.name} ★ ${s.average === null ? '' : one.format(s.average)} (${s.count})`,
                  })),
                ].map((chip) => (
                  <button
                    key={chip.serviceId ?? 'all'}
                    type="button"
                    aria-pressed={serviceId === chip.serviceId}
                    onClick={() => {
                      setServiceId(chip.serviceId);
                      setRating(null);
                    }}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            ) : null}
            <StarFilter stars={list.stars} value={rating} onChange={setRating} />
            {manager && (list.unanswered > 0 || unanswered) ? (
              <div className="chips">
                <button
                  type="button"
                  aria-pressed={unanswered}
                  onClick={() => setUnanswered(!unanswered)}
                >
                  {fill(t.reviewsCabinet.unanswered, { n: String(list.unanswered) })}
                </button>
              </div>
            ) : null}
            {list.items.length === 0 ? (
              <p className="note">{t.reviewsCabinet.empty}</p>
            ) : (
              <ul className="list">
                {list.items.map((r) => (
                  <li key={r.id} className="list-row">
                    <span className="grow">
                      <span className="review-head">
                        <Stars value={r.rating} />
                        <strong>{r.customerName ?? t.reviewsCabinet.anonymous}</strong>
                      </span>
                      <span className="small muted">
                        {r.staffName} · {r.serviceName} ·{' '}
                        {fill(t.reviewsCabinet.visit, { date: day(r.visitStartAt) })}
                      </span>
                      {r.text ? <span className="review-text">{r.text}</span> : null}
                      <ReviewReply
                        base={base}
                        review={r}
                        manager={manager}
                        onSaved={(saved) =>
                          setList((current) =>
                            current
                              ? {
                                  ...current,
                                  items: current.items.map((i) => (i.id === saved.id ? saved : i)),
                                }
                              : current,
                          )
                        }
                      />
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {list.nextBefore ? (
              <>
                <button
                  type="button"
                  className="btn btn--quiet"
                  disabled={loadingMore}
                  aria-describedby={moreError ? 'reviews-more-error' : undefined}
                  onClick={() => void more()}
                >
                  {t.reviews.more}
                </button>
                <FieldError id="reviews-more-error" text={moreError} />
              </>
            ) : null}
          </section>
        )}
      </div>
    </>
  );
}

/** The server said the answer's text is wrong (empty after trimming, too long). */
function textPathOf(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return false;
  if (!Array.isArray(err.details)) return false;
  return (err.details as { path?: string }[]).some((d) => String(d.path ?? '') === 'text');
}

function ReviewReply({
  base,
  review,
  manager,
  onSaved,
}: {
  base: string;
  review: Review;
  manager: boolean;
  onSaved: (review: Review) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(review.reply ?? '');
  const [error, setError] = useState('');
  /**
   * Task 681 (owner's rule: errors at the field): an empty answer (or only spaces) used to switch
   * "Opublikuj odpowiedź" off without a word; now "Uzupełnij to pole." is said under the answer,
   * and the server's answer about the text, too. Typing takes the error away.
   */
  const [textProblem, setTextProblem] = useState(false);
  /**
   * Task 747 (owner's rule: errors where the action is): a refused "Opublikuj odpowiedź" or
   * "Usuń odpowiedź" is said under that button (red "!" text), not as a box above the buttons.
   */
  const [failed, setFailed] = useState<'PUT' | 'DELETE' | null>(null);
  const { busy, lock, unlock } = useSubmitLock();
  const errorId = `review-${review.id}-reply-send-error`;

  async function send(method: 'PUT' | 'DELETE') {
    if (!lock()) return;
    setError('');
    setTextProblem(false);
    try {
      const saved = await api<Review>(`${base}/reviews/${review.id}/reply`, {
        method,
        ...(method === 'PUT' ? { body: { text } } : {}),
      });
      setEditing(false);
      setText(saved.reply ?? '');
      onSaved(saved);
    } catch (err) {
      if (method === 'PUT' && textPathOf(err)) setTextProblem(true);
      else setError(errorText(t, err));
      setFailed(method);
    } finally {
      unlock();
    }
  }

  if (editing) {
    return (
      <form
        className="review-reply-form"
        aria-label={t.reviewsCabinet.replyLabel}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) {
            void send('PUT');
            return;
          }
          setError('');
          setTextProblem(true);
          e.currentTarget.querySelector('textarea')?.focus();
        }}
      >
        <label className="field">
          <span>{t.reviewsCabinet.replyLabel}</span>
          <textarea
            value={text}
            maxLength={1000}
            aria-invalid={textProblem || undefined}
            aria-describedby={textProblem ? `review-${review.id}-reply-error` : undefined}
            onChange={(e) => {
              setText(e.target.value);
              setTextProblem(false);
              setError('');
            }}
          />
          <FieldError
            id={`review-${review.id}-reply-error`}
            text={textProblem ? t.onboarding.fieldRequired : undefined}
          />
        </label>
        <p className="small muted">{t.reviewsCabinet.replyHint}</p>
        <div className="review-reply-actions">
          <button
            className="btn btn--primary"
            disabled={busy}
            aria-describedby={error && failed === 'PUT' ? errorId : undefined}
          >
            {t.reviewsCabinet.replySave}
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              setEditing(false);
              setText(review.reply ?? '');
              setError('');
              setTextProblem(false);
            }}
          >
            {t.reviewsCabinet.replyCancel}
          </button>
        </div>
        <FieldError id={errorId} text={failed === 'PUT' ? error : undefined} />
      </form>
    );
  }

  return (
    <>
      <SalonReply text={review.reply} />
      {manager ? (
        <div className="review-reply-actions">
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              setError('');
              setEditing(true);
            }}
          >
            {review.reply ? t.reviewsCabinet.replyChange : t.reviewsCabinet.reply}
          </button>
          {review.reply ? (
            <button
              type="button"
              className="btn btn--quiet"
              disabled={busy}
              aria-describedby={error && failed === 'DELETE' ? errorId : undefined}
              onClick={() => void send('DELETE')}
            >
              {t.reviewsCabinet.replyRemove}
            </button>
          ) : null}
        </div>
      ) : null}
      <FieldError id={errorId} text={failed === 'DELETE' ? error : undefined} />
    </>
  );
}

function ReviewSettingsForm({ base, onSaved }: { base: string; onSaved: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<ReviewSettings | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  /**
   * Task 747 (owner's rule: errors where the action is): a refused "Zapisz" is said under the
   * button; the box stays only for settings that failed to load.
   */
  const [saveError, setSaveError] = useState('');
  const { busy, lock, unlock } = useSubmitLock();

  useEffect(() => {
    api<ReviewSettings>(`${base}/review-settings`)
      .then(setForm)
      .catch((err) => setError(errorText(t, err)));
  }, [base, t]);

  if (!form) return <ErrorBox>{error}</ErrorBox>;

  async function save(current: ReviewSettings) {
    if (!lock()) return;
    setSaveError('');
    setSaved(false);
    try {
      setForm(
        await api<ReviewSettings>(`${base}/review-settings`, {
          method: 'PUT',
          body: {
            version: current.version,
            enabled: current.enabled,
            requestHours: current.requestHours,
          },
        }),
      );
      setSaved(true);
      onSaved();
    } catch (err) {
      setSaveError(errorText(t, err));
    } finally {
      unlock();
    }
  }

  return (
    <form
      className="form section"
      aria-label={t.reviewsCabinet.settings}
      onSubmit={(e) => {
        e.preventDefault();
        void save(form);
      }}
    >
      <h2>{t.reviewsCabinet.settings}</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => {
            setForm({ ...form, enabled: e.target.checked });
            setSaveError('');
          }}
        />
        <span>{t.reviewsCabinet.enabled}</span>
      </label>
      <p className="small muted">{t.reviewsCabinet.hint}</p>
      <label className="field">
        <span>{t.reviewsCabinet.askAfter}</span>
        <select
          value={form.requestHours}
          disabled={!form.enabled}
          onChange={(e) => {
            setForm({ ...form, requestHours: Number(e.target.value) });
            setSaveError('');
          }}
        >
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {fill(t.reviewsCabinet.hours, { n: String(h) })}
            </option>
          ))}
        </select>
      </label>
      {saved ? (
        <p className="note" role="status">
          {t.reviewsCabinet.saved}
        </p>
      ) : null}
      <button
        className="btn btn--primary"
        disabled={busy}
        aria-describedby={saveError ? 'review-settings-save-error' : undefined}
      >
        {t.reviewsCabinet.save}
      </button>
      <FieldError id="review-settings-save-error" text={saveError} />
    </form>
  );
}
