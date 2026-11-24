import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ClientApi, type Locale, type PublicReviews } from '../api';
import { API_URL } from '../config';
import { tokenStore } from '../storage';
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
type CachedReviews = {
  expires: number;
  first: PublicReviews;
  more: Map<string, PublicReviews>;
};
const recent = new Map<string, CachedReviews>();

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

const ReviewRow = memo(function ReviewRow({
  review,
  locale,
  t,
  divided,
}: {
  review: SalonReview;
  locale: Locale;
  t: Dictionary;
  divided: boolean;
}) {
  return (
    <View style={[styles.row, divided && styles.divider]}>
      <Text
        role="img"
        accessible
        style={styles.stars}
        accessibilityLabel={fill(t.review.outOf, { n: String(review.rating) })}
      >
        {starText(review.rating)}
      </Text>
      {review.text ? <Text style={styles.text}>{review.text}</Text> : null}
      <Text style={styles.muted}>{salonReviewLine(review, locale)}</Text>
      {review.reply ? (
        <View
          style={styles.reply}
          accessible
          accessibilityLabel={`${t.salonReviews.salonReply}: ${review.reply}`}
        >
          <Text style={styles.replyTitle}>{t.salonReviews.salonReply}</Text>
          <Text style={styles.text}>{review.reply}</Text>
        </View>
      ) : null}
    </View>
  );
});

function ReviewsList({ api, t, locale, slug }: ReviewsProps) {
  const r = t.salonReviews;
  const [all, setAll] = useState<PublicReviews | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [stars, setStars] = useState<number[]>([]);
  const [items, setItems] = useState<SalonReview[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState<'page' | 'more' | null>('page');
  const reader = useRef<ClientApi | null>(null);
  const active = useRef<{ key: string } | null>(null);
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(
    async (who: string | null, withStars: number | null, before?: string, reuse = false) => {
      const client = reader.current;
      const key = JSON.stringify([who, withStars, before]);
      if (!client || active.current?.key === key) return;
      const current = { key };
      active.current = current;
      setLoading(before ? 'more' : 'page');
      setFailure(null);
      try {
        const unfiltered = !who && !withStars;
        const first = unfiltered && !before;
        const cache = recent.get(slug);
        const fresh = cache && cache.expires > Date.now() ? cache : undefined;
        const cached =
          unfiltered && before ? fresh?.more.get(before) : reuse ? fresh?.first : undefined;
        const page =
          cached ??
          (await withNetworkTimeout(
            client.salonReviews(slug, {
              ...(who ? { staffId: who } : {}),
              ...(withStars ? { rating: withStars } : {}),
              ...(before ? { before } : {}),
            }),
          ));
        if (active.current !== current) return;
        if (!page.enabled || first) setAll(page);
        if (!page.enabled || (first && !page.items.length)) recent.delete(slug);
        else if (!cached && first) {
          recent.delete(slug);
          if (recent.size >= 32) recent.delete(recent.keys().next().value!);
          recent.set(slug, { first: page, expires: Date.now() + 5 * 60_000, more: new Map() });
        } else if (!cached && unfiltered && before) {
          fresh?.more.set(before, page);
        }
        setStaffId(who);
        setRating(withStars);
        setStars(page.stars);
        setItems((shown) => appendSalonReviews(before ? shown : [], page.items));
        setNext(page.nextBefore);
      } catch (e) {
        if (active.current === current) {
          setFailure({
            message: errorText(e, tRef.current),
            retry: () => void load(who, withStars, before),
          });
        }
      } finally {
        if (active.current === current) {
          active.current = null;
          setLoading(null);
        }
      }
    },
    [slug],
  );

  useEffect(() => {
    const controller = new AbortController();
    reader.current = new ClientApi(API_URL, tokenStore, (url, init) =>
      fetch(url, { ...init, signal: controller.signal }),
    );
    void load(null, null, undefined, true);
    return () => {
      active.current = null;
      reader.current = null;
      controller.abort();
    };
  }, [api, load]);

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
          <ReviewRow key={review.id} review={review} locale={locale} t={t} divided={i > 0} />
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
