import { useCallback, useEffect, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, Locale, SalonReviews } from '../api';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { appendReviews, reviewLine, reviewSummary, stars, type Review } from '../reviews';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 201: "Opinie" in the business app — the average, then each review: stars, the client's
 * words, who, what, with whom and when. Newest first, 20 at a time.
 */
export function ReviewsScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  timeZone: string;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const r = t.reviews;
  const [summary, setSummary] = useState<Pick<
    SalonReviews,
    'count' | 'average' | 'enabled'
  > | null>(null);
  const [items, setItems] = useState<Review[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (before?: string) => {
      setBusy(true);
      try {
        const page = await api.reviews(salon.orgId, salon.locationId, before);
        setSummary({ count: page.count, average: page.average, enabled: page.enabled });
        setItems((shown) => (before && shown ? appendReviews(shown, page.items) : page.items));
        setNext(page.nextBefore);
        setError('');
      } catch (e) {
        setError(errorText(e, t));
      } finally {
        setBusy(false);
      }
    },
    [api, salon, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Android's back button closes the screen instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Button kind="link" label={r.back} onPress={onBack} />
      <Heading>{r.title}</Heading>
      <Text style={styles.muted}>{r.hint}</Text>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {summary && !summary.enabled ? <Text style={styles.note}>{r.off}</Text> : null}
      {summary ? (
        <Text style={styles.summary} accessibilityRole="header">
          {reviewSummary(summary, t, props.locale)}
        </Text>
      ) : null}
      {items === null ? (
        error ? null : (
          <Text style={styles.muted}>{t.loading}</Text>
        )
      ) : items.length > 0 ? (
        <Card>
          {items.map((review, i) => (
            <View
              key={review.id}
              style={[styles.row, i > 0 && styles.divider]}
              accessible
              accessibilityLabel={`${review.rating}/5. ${review.text ?? ''} ${reviewLine(
                review,
                t,
                props.locale,
                props.timeZone,
              )}`}
            >
              <Text style={styles.stars}>{stars(review.rating)}</Text>
              {review.text ? <Text style={styles.text}>{review.text}</Text> : null}
              <Text style={styles.muted}>
                {reviewLine(review, t, props.locale, props.timeZone)}
              </Text>
            </View>
          ))}
        </Card>
      ) : null}
      {next ? (
        <Button kind="secondary" label={r.more} busy={busy} onPress={() => void load(next)} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  row: { paddingVertical: 10, gap: 4 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  stars: { fontSize: 18, color: colors.ink, letterSpacing: 2 },
  summary: { fontSize: 20, fontWeight: '700', color: colors.ink },
  text: { fontSize: 16, color: colors.ink },
  note: { fontSize: 14, color: colors.ink },
  muted: { color: colors.muted, fontSize: 14 },
});
