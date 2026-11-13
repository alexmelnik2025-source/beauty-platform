import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ClientApi, Locale, PublicReviews } from '../api';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import {
  appendSalonReviews,
  salonReviewLine,
  salonReviewSummary,
  staffChip,
  starChips,
  starText,
  type SalonReview,
} from '../salonReviews';
import { Button, Card, colors, ErrorText } from '../ui';

/**
 * Task 212: "Opinie" on the salon page — the average, the specialists' averages as chips (tap —
 * only their reviews), then the reviews: stars, words, with whom, what and when, and the salon's
 * answer under a review. Nothing is shown while the salon does not collect reviews or has none.
 * Task 381: "★ 5 (12)" chips — only the reviews with that many stars.
 */
export function SalonReviews(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  slug: string;
}) {
  const { api, t, locale, slug } = props;
  const r = t.salonReviews;
  const [all, setAll] = useState<PublicReviews | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [stars, setStars] = useState<number[]>([]);
  const [items, setItems] = useState<SalonReview[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(
    async (who: string | null, withStars: number | null, before?: string) => {
      setBusy(true);
      try {
        const page = await api.salonReviews(slug, {
          ...(who ? { staffId: who } : {}),
          ...(withStars ? { rating: withStars } : {}),
          ...(before ? { before } : {}),
        });
        if (!who && !withStars && !before) setAll(page);
        setStars(page.stars);
        setItems((shown) => (before ? appendSalonReviews(shown, page.items) : page.items));
        setNext(page.nextBefore);
        setError('');
      } catch (e) {
        setError(errorText(e, tRef.current));
      } finally {
        setBusy(false);
      }
    },
    [api, slug],
  );

  useEffect(() => {
    void load(null, null);
  }, [load]);

  if (error && !all) return null;
  const summary = all ? salonReviewSummary(all, t, locale) : null;
  if (!all || !summary) return null;

  return (
    <Card>
      <View style={styles.box} role="region" aria-label={r.title}>
        <Text role="heading" aria-level={2} style={styles.section}>
          {r.title}
        </Text>
        <Text style={styles.summary}>{summary}</Text>
        {all.staff.length > 1 ? (
          <View style={styles.chips} role="radiogroup" aria-label={r.bySpecialist}>
            {[
              { id: null, label: r.everyone },
              ...all.staff.map((s) => ({ id: s.staffId, label: staffChip(s, locale) })),
            ].map((chip) => (
              <Pressable
                key={chip.id ?? 'all'}
                role="radio"
                aria-checked={staffId === chip.id}
                aria-label={chip.label}
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
        {starChips(stars, rating).length > 0 ? (
          <View style={styles.chips} role="radiogroup" aria-label={r.byStars}>
            {[{ rating: null, label: r.allStars }, ...starChips(stars, rating)].map((chip) => (
              <Pressable
                key={chip.rating ?? 'all'}
                role="radio"
                aria-checked={rating === chip.rating}
                aria-label={chip.label}
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
        {items.map((review, i) => (
          <View key={review.id} style={[styles.row, i > 0 && styles.divider]}>
            <Text style={styles.stars} aria-label={`${review.rating}/5`}>
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
    minHeight: 36,
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
  row: { paddingVertical: 8, gap: 4 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  stars: { fontSize: 16, color: colors.accent, letterSpacing: 2 },
  text: { fontSize: 15, color: colors.ink, lineHeight: 21 },
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
