import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ClientApi, Locale, PublicReviews } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  appendSalonReviews,
  oneDecimal,
  salonReviewLine,
  salonReviewSummary,
  staffChip,
  starChips,
  starText,
  type SalonReview,
} from '../salonReviews';
import { Button, Card, colors, ErrorText, Pressable } from '../ui';

/**
 * Task 212: "Opinie" on the salon page — the average, the specialists' averages as chips (tap —
 * only their reviews), then the reviews: stars, words, with whom, what and when, and the salon's
 * answer under a review. Nothing is shown while the salon does not collect reviews.
 * Task 381: "★ 5 (12)" chips — only the reviews with that many stars.
 */
type ReviewsProps = {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  slug: string;
};

export function SalonReviews(props: ReviewsProps) {
  return <ReviewsList key={props.slug} {...props} />;
}

function ReviewsList({ api, t, locale, slug }: ReviewsProps) {
  const r = t.salonReviews;
  const [all, setAll] = useState<PublicReviews | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [stars, setStars] = useState<number[]>([]);
  const [items, setItems] = useState<SalonReview[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const requestId = useRef(0);
  const [error, setError] = useState('');
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(
    async (who: string | null, withStars: number | null, before?: string) => {
      const current = ++requestId.current;
      setBusy(true);
      setError('');
      if (!before) {
        setItems([]);
        setNext(null);
      }
      try {
        const page = await api.salonReviews(slug, {
          ...(who ? { staffId: who } : {}),
          ...(withStars ? { rating: withStars } : {}),
          ...(before ? { before } : {}),
        });
        if (current !== requestId.current) return;
        if (!page.enabled || (!who && !withStars && !before)) setAll(page);
        setStars(page.stars);
        setItems((shown) => appendSalonReviews(before ? shown : [], page.items));
        setNext(page.nextBefore);
      } catch (e) {
        if (current === requestId.current) setError(errorText(e, tRef.current));
      } finally {
        if (current === requestId.current) setBusy(false);
      }
    },
    [api, slug],
  );

  useEffect(() => {
    void load(null, null);
    return () => {
      requestId.current++;
    };
  }, [load]);

  if (all && !all.enabled) return null;
  const summary = all ? salonReviewSummary(all, t, locale) : null;
  const filters = starChips(stars, rating);
  const ratingLabel = (n: string) => fill(t.review.outOf, { n });
  const reviewCount = (count: number) => `${r.title}: ${count}`;

  return (
    <Card>
      <View style={styles.box} role="region" aria-label={r.title}>
        <Text role="heading" aria-level={2} style={styles.section}>
          {r.title}
        </Text>
        {summary && all?.average != null ? (
          <Text
            style={styles.summary}
            accessibilityLabel={`${ratingLabel(oneDecimal(all.average, locale))}, ${reviewCount(all.count)}`}
          >
            {summary}
          </Text>
        ) : null}
        {all && all.staff.length > 1 ? (
          <View style={styles.chips} role="radiogroup" aria-label={r.bySpecialist}>
            {[
              { id: null, label: r.everyone, spoken: r.everyone },
              ...all.staff.map((s) => ({
                id: s.staffId,
                label: staffChip(s, locale),
                spoken: [
                  s.displayName,
                  s.average == null ? null : ratingLabel(oneDecimal(s.average, locale)),
                  reviewCount(s.count),
                ]
                  .filter(Boolean)
                  .join(', '),
              })),
            ].map((chip) => (
              <Pressable
                key={chip.id ?? 'all'}
                role="radio"
                aria-checked={staffId === chip.id}
                aria-label={chip.spoken}
                onPress={() => {
                  setStaffId(chip.id);
                  setRating(null);
                  void load(chip.id, null);
                }}
                style={[styles.chip, staffId === chip.id && styles.chipOn]}
              >
                <Text style={[styles.chipText, staffId === chip.id && styles.chipTextOn]}>
                  {chip.label}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {filters.length > 0 ? (
          <View style={styles.chips} role="radiogroup" aria-label={r.byStars}>
            {[{ rating: null, label: r.allStars }, ...filters].map((chip) => (
              <Pressable
                key={chip.rating ?? 'all'}
                role="radio"
                aria-checked={rating === chip.rating}
                aria-label={
                  chip.rating === null
                    ? r.allStars
                    : `${ratingLabel(String(chip.rating))}, ${reviewCount(stars[chip.rating - 1] ?? 0)}`
                }
                onPress={() => {
                  setRating(chip.rating);
                  void load(staffId, chip.rating);
                }}
                style={[styles.chip, rating === chip.rating && styles.chipOn]}
              >
                <Text style={[styles.chipText, rating === chip.rating && styles.chipTextOn]}>
                  {chip.label}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {busy && items.length === 0 ? (
          <View
            accessible
            role="progressbar"
            accessibilityLabel={r.title}
            aria-busy
            style={styles.skeleton}
          >
            <View style={styles.skeletonLine} />
            <View style={[styles.skeletonLine, { width: '65%' }]} />
          </View>
        ) : null}
        {!busy && !error && items.length === 0 ? (
          <Text role="status" aria-live="polite" style={styles.muted}>
            {reviewCount(0)}
          </Text>
        ) : null}
        {items.map((review, i) => (
          <View key={review.id} style={[styles.row, i > 0 && styles.divider]}>
            <Text
              role="img"
              accessible
              style={styles.stars}
              accessibilityLabel={ratingLabel(String(review.rating))}
            >
              {starText(review.rating)}
            </Text>
            {review.text ? <Text style={styles.text}>{review.text}</Text> : null}
            <Text style={styles.muted}>{salonReviewLine(review, locale)}</Text>
            {review.reply ? (
              <View
                style={styles.reply}
                accessible
                accessibilityLabel={`${r.salonReply}: ${review.reply}`}
              >
                <Text style={styles.replyTitle}>{r.salonReply}</Text>
                <Text style={styles.text}>{review.reply}</Text>
              </View>
            ) : null}
          </View>
        ))}
        {error ? <ErrorText>{error}</ErrorText> : null}
        {error && !next ? (
          <Button kind="secondary" label={t.retry} onPress={() => void load(staffId, rating)} />
        ) : null}
        {next ? (
          <Button
            kind="secondary"
            label={r.more}
            busy={busy}
            onPress={() => void load(staffId, rating, next)}
          />
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8 },
  section: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  summary: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    maxWidth: '100%',
    paddingVertical: 6,
    minHeight: 44,
    paddingHorizontal: 12,
    justifyContent: 'center',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { color: colors.ink, fontSize: 14 },
  chipTextOn: { color: '#fff' },
  skeleton: { gap: 6, paddingVertical: 8 },
  skeletonLine: { height: 12, borderRadius: 6, backgroundColor: colors.soft },
  row: { paddingVertical: 8, gap: 4 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  stars: { fontSize: 16, color: colors.accent, letterSpacing: 2 },
  text: { fontSize: 15, color: colors.ink },
  muted: { color: colors.muted, fontSize: 13 },
  reply: {
    gap: 2,
    paddingLeft: 12,
    paddingVertical: 4,
    borderLeftWidth: 2,
    borderLeftColor: colors.ink,
  },
  replyTitle: { fontSize: 13, fontWeight: '700', color: colors.ink },
});
