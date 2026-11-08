import { useCallback, useEffect, useState } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  ApiError,
  type BusinessApi,
  type Locale,
  type ReviewSettings,
  type SalonReviews,
} from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  appendReviews,
  reviewHoursChoices,
  reviewLine,
  reviewSettingsChanged,
  reviewSummary,
  stars,
  type Review,
} from '../reviews';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 201: "Opinie" in the business app — the average, then each review: stars, the client's
 * words, who, what, with whom and when. Newest first, 20 at a time. Task 211: the owner and
 * managers answer a review publicly, change or remove the answer. Task 341: they also switch
 * collecting reviews on or off and choose when the client is asked, as in the cabinet.
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
  const manager = salon.role !== 'staff';
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
      {manager ? (
        <ReviewSettingsCard
          api={api}
          t={t}
          salon={salon}
          onSaved={(enabled) => setSummary((shown) => (shown ? { ...shown, enabled } : shown))}
        />
      ) : summary && !summary.enabled ? (
        <Text style={styles.note}>{r.off}</Text>
      ) : null}
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
            <ReviewRow
              key={review.id}
              review={review}
              first={i === 0}
              manager={manager}
              t={t}
              line={reviewLine(review, t, props.locale, props.timeZone)}
              onReply={(text) =>
                text === null
                  ? api.removeReviewReply(salon.orgId, salon.locationId, review.id)
                  : api.replyToReview(salon.orgId, salon.locationId, review.id, text)
              }
              onSaved={(saved) =>
                setItems((shown) =>
                  shown ? shown.map((x) => (x.id === saved.id ? saved : x)) : shown,
                )
              }
            />
          ))}
        </Card>
      ) : null}
      {next ? (
        <Button kind="secondary" label={r.more} busy={busy} onPress={() => void load(next)} />
      ) : null}
    </ScrollView>
  );
}

function ReviewRow(props: {
  review: Review;
  first: boolean;
  manager: boolean;
  t: Dictionary;
  line: string;
  onReply: (text: string | null) => Promise<Review>;
  onSaved: (review: Review) => void;
}) {
  const { review, t } = props;
  const r = t.reviews;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(review.reply ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function send(value: string | null) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const saved = await props.onReply(value);
      setEditing(false);
      setText(saved.reply ?? '');
      props.onSaved(saved);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.row, !props.first && styles.divider]}>
      <View
        accessible
        accessibilityLabel={`${review.rating}/5. ${review.text ?? ''} ${props.line}`}
        style={styles.gap}
      >
        <Text style={styles.stars}>{stars(review.rating)}</Text>
        {review.text ? <Text style={styles.text}>{review.text}</Text> : null}
        <Text style={styles.muted}>{props.line}</Text>
      </View>
      {review.reply && !editing ? (
        <View
          style={styles.reply}
          accessible
          accessibilityLabel={`${r.replyLabel}: ${review.reply}`}
        >
          <Text style={styles.replyTitle}>{r.replyLabel}</Text>
          <Text style={styles.text}>{review.reply}</Text>
        </View>
      ) : null}
      {editing ? (
        <View style={styles.gap}>
          <TextInput
            accessibilityLabel={r.replyLabel}
            placeholder={r.replyLabel}
            placeholderTextColor={colors.placeholder}
            value={text}
            onChangeText={setText}
            maxLength={1000}
            multiline
            style={[styles.input, styles.multiline]}
          />
          <Text style={styles.muted}>{r.replyHint}</Text>
          <Button
            label={r.replySave}
            busy={busy}
            disabled={!text.trim()}
            onPress={() => void send(text.trim())}
          />
          <Button
            kind="link"
            label={r.replyCancel}
            onPress={() => {
              setEditing(false);
              setText(review.reply ?? '');
              setError('');
            }}
          />
        </View>
      ) : props.manager ? (
        <View style={styles.actions}>
          <Button
            kind="secondary"
            label={review.reply ? r.replyChange : r.reply}
            onPress={() => setEditing(true)}
          />
          {review.reply ? (
            <Button kind="link" label={r.replyRemove} busy={busy} onPress={() => void send(null)} />
          ) : null}
        </View>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
}

/** Task 341: "Ustawienia opinii" (owners and managers; the server checks the role too). */
function ReviewSettingsCard(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  onSaved: (enabled: boolean) => void;
}) {
  const { api, t, salon } = props;
  const r = t.reviews;
  const [saved, setSaved] = useState<ReviewSettings | null>(null);
  const [form, setForm] = useState<ReviewSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  const load = useCallback(async () => {
    const current = await api.reviewSettings(salon.orgId, salon.locationId);
    setSaved(current);
    setForm(current);
  }, [api, salon]);

  useEffect(() => {
    load().catch((e) => setNote({ text: errorText(e, t), bad: true }));
  }, [load, t]);

  if (!saved || !form) {
    return note ? <ErrorText>{note.text}</ErrorText> : null;
  }

  async function save() {
    if (!form) return;
    setBusy(true);
    setNote(null);
    try {
      const done = await api.saveReviewSettings(salon.orgId, salon.locationId, form);
      setSaved(done);
      setForm(done);
      props.onSaved(done.enabled);
      setNote({ text: r.saved, bad: false });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setNote({ text: r.conflict, bad: true });
        await load().catch(() => undefined);
      } else {
        setNote({ text: errorText(e, t), bad: true });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Text style={styles.replyTitle} role="heading">
        {r.settings}
      </Text>
      <Text style={styles.muted}>{r.settingsHint}</Text>
      <View style={styles.actions}>
        <Chip
          label={r.collect}
          on={form.enabled}
          onPress={() => setForm({ ...form, enabled: true })}
        />
        <Chip
          label={r.dontCollect}
          on={!form.enabled}
          onPress={() => setForm({ ...form, enabled: false })}
        />
      </View>
      {form.enabled ? (
        <>
          <Text style={styles.muted}>{r.askAfter}</Text>
          <View style={styles.actions}>
            {reviewHoursChoices(form.requestHours).map((n) => (
              <Chip
                key={n}
                label={fill(r.hours, { n: String(n) })}
                a11yLabel={fill(r.hoursLabel, { n: String(n) })}
                on={form.requestHours === n}
                onPress={() => setForm({ ...form, requestHours: n })}
              />
            ))}
          </View>
        </>
      ) : null}
      {note ? (
        note.bad ? (
          <ErrorText>{note.text}</ErrorText>
        ) : (
          <Text role="status" style={styles.info}>
            {note.text}
          </Text>
        )
      ) : null}
      <Button
        label={r.save}
        busy={busy}
        disabled={!reviewSettingsChanged(saved, form) && saved.version > 0}
        onPress={() => void save()}
      />
    </Card>
  );
}

function Chip(props: { label: string; a11yLabel?: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.a11yLabel ?? props.label}
      aria-pressed={props.on}
      accessibilityState={{ selected: props.on }}
      onPress={props.onPress}
      style={[styles.chip, props.on && styles.chipOn]}
    >
      <Text style={[styles.chipText, props.on && { color: '#fff' }]}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 4 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  reply: {
    marginTop: 4,
    paddingLeft: 12,
    paddingVertical: 4,
    borderLeftWidth: 2,
    borderLeftColor: colors.ink,
    gap: 2,
  },
  replyTitle: { fontSize: 13, fontWeight: '700', color: colors.ink },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.ink,
  },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  screen: { padding: 20, gap: 12 },
  row: { paddingVertical: 10, gap: 8 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  stars: { fontSize: 18, color: colors.ink, letterSpacing: 2 },
  summary: { fontSize: 20, fontWeight: '700', color: colors.ink },
  text: { fontSize: 16, color: colors.ink },
  note: { fontSize: 14, color: colors.ink },
  muted: { color: colors.muted, fontSize: 14 },
  info: { color: '#2e7d32', fontSize: 15 },
  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 15, color: colors.ink },
});
