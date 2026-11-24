import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ClientApi, Locale, PublicReviews } from '../api';
import { errorText, type FormFailure } from '../errors';
import { FormFeedback } from '../FormFeedback';
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
import { Button, Card, colors, Pressable } from '../ui';
import { withNetworkTimeout } from '../withNetworkTimeout';

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

// Public reviews are shared across visits to the same salon within this app session.
const firstPages = new Map<string, { expires: number; page: PublicReviews }>();
const pendingPages = new Map<string, Promise<PublicReviews>>();

async function firstPage(api: ClientApi, slug: string, reuse: boolean) {
  const now = Date.now();
  for (const [key, entry] of firstPages) {
    if (entry.expires <= now) firstPages.delete(key);
  }
  const cached = firstPages.get(slug);
  if (reuse && cached) return cached.page;
  const pending = pendingPages.get(slug);
  if (pending) return pending;

  const request = withNetworkTimeout(api.salonReviews(slug));
  pendingPages.set(slug, request);
  try {
    const page = await request;
    // An empty salon is checked again on return so its first review can appear.
    if (page.enabled && page.items.length > 0) {
      firstPages.set(slug, { expires: Date.now() + 5 * 60_000, page });
    } else {
      firstPages.delete(slug);
    }
    return page;
  } finally {
    pendingPages.delete(slug);
  }
}

export function SalonReviews(props: ReviewsProps) {
  return <ReviewsList key={props.slug} {...props} />;
}

function ReviewFilter({
  label,
  description,
  selected,
  onPress,
}: {
  label: string;
  description?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const descriptionId = useId();
  return (
    <Pressable
      role="radio"
      aria-checked={selected}
      accessibilityLabel={label}
      accessibilityHint={description}
      aria-describedby={description ? descriptionId : undefined}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipOn]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
      {description ? (
        <Text nativeID={descriptionId} style={{ display: 'none' }}>
          {description}
        </Text>
      ) : null}
    </Pressable>
  );
}

function ReviewsList({ api, t, locale, slug }: ReviewsProps) {
  const r = t.salonReviews;
  const [all, setAll] = useState<PublicReviews | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [stars, setStars] = useState<number[]>([]);
  const [items, setItems] = useState<SalonReview[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState<'page' | 'more' | null>('page');
  const requestId = useRef(0);
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(
    async (who: string | null, withStars: number | null, before?: string, reuse = false) => {
      const current = ++requestId.current;
      setLoading(before ? 'more' : 'page');
      setFailure(null);
      try {
        const unfiltered = !who && !withStars && !before;
        const page = unfiltered
          ? await firstPage(api, slug, reuse)
          : await withNetworkTimeout(
              api.salonReviews(slug, {
                ...(who ? { staffId: who } : {}),
                ...(withStars ? { rating: withStars } : {}),
                ...(before ? { before } : {}),
              }),
            );
        if (current !== requestId.current) return;
        if (!page.enabled || unfiltered) setAll(page);
        if (!page.enabled) firstPages.delete(slug);
        setStaffId(who);
        setRating(withStars);
        setStars(page.stars);
        setItems((shown) => appendSalonReviews(before ? shown : [], page.items));
        setNext(page.nextBefore);
      } catch (e) {
        if (current === requestId.current) {
          setFailure({
            message: errorText(e, tRef.current),
            retry: () => void load(who, withStars, before),
          });
        }
      } finally {
        if (current === requestId.current) setLoading(null);
      }
    },
    [api, slug],
  );

  useEffect(() => {
    void load(null, null, undefined, true);
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
            accessible
            role="img"
            style={styles.summary}
            accessibilityLabel={`${ratingLabel(oneDecimal(all.average, locale))}, ${reviewCount(all.count)}`}
          >
            {summary}
          </Text>
        ) : null}
        {all && all.staff.length > 1 ? (
          <View style={styles.chips} role="radiogroup" aria-label={r.bySpecialist}>
            {[
              { id: null, label: r.everyone, description: undefined },
              ...all.staff.map((s) => ({
                id: s.staffId,
                label: staffChip(s, locale),
                description: [
                  s.average == null ? null : ratingLabel(oneDecimal(s.average, locale)),
                  reviewCount(s.count),
                ]
                  .filter(Boolean)
                  .join(', '),
              })),
            ].map((chip) => (
              <ReviewFilter
                key={chip.id ?? 'all'}
                label={chip.label}
                selected={staffId === chip.id}
                description={chip.description}
                onPress={() => {
                  void load(chip.id, null);
                }}
              />
            ))}
          </View>
        ) : null}
        {filters.length > 0 ? (
          <View style={styles.chips} role="radiogroup" aria-label={r.byStars}>
            {[{ rating: null, label: r.allStars }, ...filters].map((chip) => (
              <ReviewFilter
                key={chip.rating ?? 'all'}
                label={chip.label}
                selected={rating === chip.rating}
                description={
                  chip.rating === null
                    ? undefined
                    : `${ratingLabel(String(chip.rating))}, ${reviewCount(stars[chip.rating - 1] ?? 0)}`
                }
                onPress={() => {
                  void load(staffId, chip.rating);
                }}
              />
            ))}
          </View>
        ) : null}
        {loading === 'page' ? (
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
        {!loading && !failure && items.length === 0 ? (
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
        <FormFeedback failure={failure} retryLabel={t.retry} />
        {next && !failure && loading !== 'page' ? (
          <Button
            kind="secondary"
            label={r.more}
            busy={loading === 'more'}
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
