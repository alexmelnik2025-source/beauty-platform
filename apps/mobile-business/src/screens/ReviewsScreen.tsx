import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ApiError,
  type BusinessApi,
  type Locale,
  type ReviewSettings,
  type SalonReviews,
} from '../api';
import { errorText } from '../errors';
import { shareCsv } from '../share';
import { csvTools } from './csvTools';
import { fill, type Dictionary } from '../i18n';
import {
  appendReviews,
  reviewHoursChoices,
  reviewLine,
  reviewSettingsChanged,
  reviewSummary,
  serviceReviewChip,
  staffReviewChip,
  starChips,
  stars,
  type Review,
} from '../reviews';
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
import type { SalonChoice } from './SalonsScreen';
import { SalonReadCache, useScreenLifetime } from './HistoryScreen';
const reviewsCache = new SalonReadCache<SalonReviews>();
const settingsCache = new SalonReadCache<ReviewSettings>();
type ReplyEditor = {
  text: string;
  editing: boolean;
  busy?: boolean;
  missingText?: boolean;
  error?: string;
};

/**
 * Task 201: "Opinie" in the business app — the average, then each review: stars, the client's
 * words, who, what, with whom and when. Newest first, 20 at a time. Task 211: the owner and
 * managers answer a review publicly, change or remove the answer. Task 341: they also switch
 * collecting reviews on or off and choose when the client is asked, as in the cabinet.
 * Task 381: "★ 1 (2)" chips — only the reviews with that many stars. Task 382: "Bez odpowiedzi
 * (n)" for the owner and managers — only the reviews they have not answered yet. Task 383:
 * "Kasia ★ 4,8 (12)" chips — only the reviews of one specialist. Task 420: "Broda ★ 4,5 (6)"
 * chips — only the reviews of visits for one service. Task 385: "Pobierz CSV opinii"
 * for the owner and managers — the reviews shown, as a file.
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
  const [page, setPage] = useState<SalonReviews | null>(null);
  const displayed = useRef<SalonReviews | null>(null);
  const show = useCallback((value: SalonReviews | null) => {
    displayed.current = value;
    setPage(value);
  }, []);
  const [rating, setRating] = useState<number | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [unanswered, setUnanswered] = useState(false);
  const key = JSON.stringify([staffId, serviceId, rating, unanswered]);
  const lifetime = useScreenLifetime(salon, key);
  const request = useRef<symbol | null>(null);
  const [editors, setEditors] = useState<Record<string, ReplyEditor | undefined>>({});
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvInfo, setCsvInfo] = useState('');

  const downloadCsv = async () => {
    if (csvBusy) return;
    const signal = lifetime.current!.signal;
    setCsvBusy(true);
    setCsvInfo('');
    try {
      const file = await api.reviewsCsv(salon.orgId, salon.locationId, props.locale, {
        staffId: staffId ?? undefined,
        serviceId: serviceId ?? undefined,
        rating: rating ?? undefined,
        unanswered,
      });
      if (signal.aborted) return;
      const result = await shareCsv(file, csvTools());
      if (!signal.aborted) setCsvInfo(result === 'failed' ? r.csvFailed : '');
    } catch (e) {
      if (!signal.aborted) setCsvInfo(errorText(e, t));
    } finally {
      if (!signal.aborted) setCsvBusy(false);
    }
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(
    async (previous?: SalonReviews) => {
      if (previous && (request.current || !previous.nextBefore)) return;
      const signal = lifetime.current!.signal;
      const id = Symbol();
      request.current = id;
      setBusy(true);
      setError('');
      try {
        const fetchPage = () =>
          api.reviews(salon.orgId, salon.locationId, {
            before: previous?.nextBefore ?? undefined,
            staffId: staffId ?? undefined,
            serviceId: serviceId ?? undefined,
            rating: rating ?? undefined,
            unanswered,
          });
        const result = previous
          ? await fetchPage()
          : await reviewsCache.read(salon, fetchPage, key);
        if (signal.aborted || request.current !== id) return;
        const current = displayed.current;
        const merged =
          previous && current
            ? {
                ...result,
                ...(previous === current
                  ? {}
                  : { enabled: current.enabled, unanswered: current.unanswered }),
                items: appendReviews(current.items, result.items),
              }
            : result;
        if (previous) reviewsCache.set(salon, merged, key);
        show(merged);
        setError('');
      } catch (e) {
        if (!signal.aborted && request.current === id) setError(errorText(e, t));
      } finally {
        if (!signal.aborted && request.current === id) {
          request.current = null;
          setBusy(false);
        }
      }
    },
    [api, salon, t, rating, unanswered, staffId, serviceId, key, lifetime, show],
  );

  useEffect(() => {
    const current = displayed.current;
    if (current) show({ ...current, items: [], nextBefore: null });
    setCsvInfo('');
    setCsvBusy(false);
    void load();
  }, [load, show]);

  const edit = useCallback((id: string, editor?: ReplyEditor) => {
    setEditors((current) => ({ ...current, [id]: editor }));
  }, []);
  const screen = useScreenLifetime(salon);
  const reply = useCallback(
    async (review: Review, value: string | null, editor: ReplyEditor) => {
      const signal = screen.current!.signal;
      const filterSignal = lifetime.current!.signal;
      edit(review.id, { ...editor, busy: true });
      try {
        const saved =
          value === null
            ? await api.removeReviewReply(salon.orgId, salon.locationId, review.id)
            : await api.replyToReview(salon.orgId, salon.locationId, review.id, value);
        reviewsCache.clear(salon);
        if (signal.aborted) return;
        edit(review.id);
        if (filterSignal.aborted) return;
        const current = displayed.current;
        if (!current || !current.items.some((item) => item.id === saved.id)) return;
        const delta = Number(!saved.reply) - Number(!review.reply);
        const updated = {
          ...current,
          unanswered: Math.max(0, current.unanswered + delta),
          items:
            unanswered && saved.reply
              ? current.items.filter((item) => item.id !== saved.id)
              : current.items.map((item) => (item.id === saved.id ? saved : item)),
        };
        reviewsCache.set(salon, updated, key);
        show(updated);
      } catch (e) {
        if (!signal.aborted) edit(review.id, { ...editor, busy: false, error: errorText(e, t) });
      }
    },
    [api, salon, screen, lifetime, key, unanswered, edit, show, t],
  );
  const settingsSaved = useCallback(
    (enabled: boolean) => {
      reviewsCache.clear(salon);
      if (displayed.current) show({ ...displayed.current, enabled });
    },
    [salon, show],
  );

  const { locale, timeZone } = props;
  const renderItem = useCallback(
    ({ item }: { item: Review }) => (
      <ReviewRow
        review={item}
        manager={manager}
        t={t}
        locale={locale}
        timeZone={timeZone}
        editor={editors[item.id]}
        edit={edit}
        reply={reply}
      />
    ),
    [manager, t, locale, timeZone, editors, edit, reply],
  );
  const summary = page;
  const team = page?.staff ?? [];
  const services = page?.services ?? [];
  const unansweredCount = page?.unanswered ?? 0;
  const chips = starChips(page?.stars ?? [], rating);

  // Android's back button closes the screen instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  return (
    <FlatList
      data={page?.items ?? []}
      renderItem={renderItem}
      contentContainerStyle={styles.screen}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={styles.header}>
          <Button kind="link" label={r.back} onPress={onBack} />
          <Heading>{r.title}</Heading>
          <Text style={styles.muted}>{r.hint}</Text>
          {error ? <ErrorText>{error}</ErrorText> : null}
          {manager ? (
            <ReviewSettingsCard api={api} t={t} salon={salon} onSaved={settingsSaved} />
          ) : summary && !summary.enabled ? (
            <Text style={styles.note}>{r.off}</Text>
          ) : null}
          {summary && summary.count > 0 ? (
            <Text style={styles.summary} accessibilityRole="header">
              {reviewSummary(summary, t, props.locale)}
            </Text>
          ) : null}
          {manager && summary && summary.count > 0 ? (
            <Button
              kind="secondary"
              label={r.csv}
              busy={csvBusy}
              onPress={() => void downloadCsv()}
            />
          ) : null}
          {csvInfo ? <Text style={styles.muted}>{csvInfo}</Text> : null}
          {team.length > 1 ? (
            <View style={styles.actions} role="group" aria-label={r.bySpecialist}>
              {[
                { staffId: null, label: r.everyone },
                ...team.map((s) => ({
                  staffId: s.staffId,
                  label: staffReviewChip(s, props.locale),
                })),
              ].map((chip) => (
                <Pressable
                  accessibilityLabel={chip.label}
                  key={chip.staffId ?? 'all'}
                  accessibilityRole="button"
                  aria-pressed={staffId === chip.staffId}
                  accessibilityState={{ selected: staffId === chip.staffId }}
                  onPress={() => {
                    setStaffId(chip.staffId);
                    setRating(null);
                  }}
                  style={[styles.chip, staffId === chip.staffId && styles.chipOn]}
                >
                  <Text style={[styles.chipText, staffId === chip.staffId && { color: '#fff' }]}>
                    {chip.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {services.length > 1 || serviceId !== null ? (
            <View style={styles.actions} role="group" aria-label={r.byService}>
              {[
                { serviceId: null, label: r.allServices },
                ...services.map((s) => ({
                  serviceId: s.serviceId,
                  label: serviceReviewChip(s, props.locale),
                })),
              ].map((chip) => (
                <Pressable
                  accessibilityLabel={chip.label}
                  key={chip.serviceId ?? 'all'}
                  accessibilityRole="button"
                  aria-pressed={serviceId === chip.serviceId}
                  accessibilityState={{ selected: serviceId === chip.serviceId }}
                  onPress={() => {
                    setServiceId(chip.serviceId);
                    setRating(null);
                  }}
                  style={[styles.chip, serviceId === chip.serviceId && styles.chipOn]}
                >
                  <Text
                    style={[styles.chipText, serviceId === chip.serviceId && { color: '#fff' }]}
                  >
                    {chip.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {chips.length > 0 ? (
            <View style={styles.actions} role="group" aria-label={r.byStars}>
              {[{ rating: null, label: r.allStars }, ...chips].map((chip) => (
                <Pressable
                  accessibilityLabel={chip.label}
                  key={chip.rating ?? 'all'}
                  accessibilityRole="button"
                  aria-pressed={rating === chip.rating}
                  accessibilityState={{ selected: rating === chip.rating }}
                  onPress={() => setRating(chip.rating)}
                  style={[styles.chip, rating === chip.rating && styles.chipOn]}
                >
                  <Text style={[styles.chipText, rating === chip.rating && { color: '#fff' }]}>
                    {chip.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {manager && (unansweredCount > 0 || unanswered) ? (
            <View style={styles.actions}>
              <Pressable
                accessibilityLabel={fill(r.unanswered, { n: String(unansweredCount) })}
                accessibilityRole="button"
                aria-pressed={unanswered}
                accessibilityState={{ selected: unanswered }}
                onPress={() => setUnanswered(!unanswered)}
                style={[styles.chip, unanswered && styles.chipOn]}
              >
                <Text style={[styles.chipText, unanswered && { color: '#fff' }]}>
                  {fill(r.unanswered, { n: String(unansweredCount) })}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        error ? undefined : !page || busy ? (
          <View
            style={styles.row}
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={t.loading}
            accessibilityState={{ busy: true }}
          >
            <Text style={styles.muted}>{t.loading}</Text>
            <View aria-hidden style={[styles.skeletonLine, { width: '40%' }]} />
            <View aria-hidden style={styles.skeletonLine} />
          </View>
        ) : (
          <Text role="status" style={styles.muted}>
            {r.none}
          </Text>
        )
      }
      ListFooterComponent={
        page?.nextBefore ? (
          <Button kind="secondary" label={r.more} busy={busy} onPress={() => void load(page)} />
        ) : undefined
      }
    />
  );
}

const ReviewRow = memo(function ReviewRow(props: {
  review: Review;
  manager: boolean;
  t: Dictionary;
  locale: Locale;
  timeZone: string;
  editor?: ReplyEditor;
  edit: (id: string, editor?: ReplyEditor) => void;
  reply: (review: Review, value: string | null, editor: ReplyEditor) => Promise<void>;
}) {
  const { review, t } = props;
  const editor = props.editor ?? { editing: false, text: review.reply ?? '' };
  const { editing, text, busy, error } = editor;
  const r = t.reviews;
  const line = reviewLine(review, t, props.locale, props.timeZone);
  const missingText = Boolean(editor.missingText);
  const fieldError = missingText ? r.reply : error;
  const errorId = `reply-error-${review.id}`;
  function publish() {
    const value = text.trim();
    if (!value) {
      props.edit(review.id, { ...editor, missingText: true, error: undefined });
      return;
    }
    void props.reply(review, value, editor);
  }
  return (
    <View style={styles.row}>
      <View style={styles.gap}>
        <Text
          accessible
          accessibilityRole="image"
          accessibilityLabel={fill(t.reports.ratings, { stars: `${review.rating}/5` })}
          style={styles.stars}
        >
          {stars(review.rating)}
        </Text>
        {review.text ? <Text style={styles.text}>{review.text}</Text> : null}
        <Text style={styles.muted}>{line}</Text>
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
            aria-required
            aria-invalid={missingText}
            aria-describedby={fieldError ? errorId : undefined}
            accessibilityHint={fieldError}
            placeholder={r.replyLabel}
            placeholderTextColor={colors.placeholder}
            value={text}
            onChangeText={(text) =>
              props.edit(review.id, {
                ...editor,
                text,
                missingText: missingText && !text.trim(),
                error: undefined,
              })
            }
            maxLength={1000}
            multiline
            style={[styles.input, styles.multiline, missingText && { borderColor: colors.danger }]}
          />
          {fieldError ? (
            <View nativeID={errorId}>
              <ErrorText>! {fieldError}</ErrorText>
            </View>
          ) : null}
          <Text style={styles.muted}>{r.replyHint}</Text>
          <Button label={r.replySave} busy={busy} onPress={publish} />
          <Button
            kind="link"
            label={r.replyCancel}
            onPress={() => {
              props.edit(review.id);
            }}
          />
        </View>
      ) : props.manager ? (
        <View style={styles.actions}>
          <Button
            kind="secondary"
            label={review.reply ? r.replyChange : r.reply}
            onPress={() => props.edit(review.id, { ...editor, editing: true })}
          />
          {review.reply ? (
            <Button
              kind="link"
              label={r.replyRemove}
              busy={busy}
              onPress={() => void props.reply(review, null, editor)}
            />
          ) : null}
        </View>
      ) : null}
      {!editing && error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
});

/** Task 341: "Ustawienia opinii" (owners and managers; the server checks the role too). */
const ReviewSettingsCard = memo(function ReviewSettingsCard(props: {
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

  const lifetime = useScreenLifetime(salon);
  const load = useCallback(async () => {
    const signal = lifetime.current!.signal;
    if (signal.aborted) return;
    const current = await settingsCache.read(salon, () =>
      api.reviewSettings(salon.orgId, salon.locationId),
    );
    if (signal.aborted) return;
    setSaved(current);
    setForm(current);
  }, [api, salon, lifetime]);

  useEffect(() => {
    const signal = lifetime.current!.signal;
    load().catch((e) => {
      if (!signal.aborted) setNote({ text: errorText(e, t), bad: true });
    });
  }, [load, t, lifetime]);

  if (!saved || !form) {
    return note ? <ErrorText>{note.text}</ErrorText> : null;
  }

  async function save() {
    if (!form) return;
    const signal = lifetime.current!.signal;
    setBusy(true);
    setNote(null);
    try {
      const done = await api.saveReviewSettings(salon.orgId, salon.locationId, form);
      settingsCache.set(salon, done);
      reviewsCache.clear(salon);
      if (signal.aborted) return;
      setSaved(done);
      setForm(done);
      props.onSaved(done.enabled);
      setNote({ text: r.saved, bad: false });
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        settingsCache.clear(salon);
        setNote({ text: r.conflict, bad: true });
        await load().catch(() => undefined);
      } else {
        setNote({ text: errorText(e, t), bad: true });
      }
    } finally {
      if (!signal.aborted) setBusy(false);
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
});

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
  gap: { gap: 4, minWidth: 0 },
  skeletonLine: { height: 12, borderRadius: 6, backgroundColor: colors.soft },
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
  screen: { padding: 20 },
  header: { gap: 12, marginBottom: 12 },
  row: {
    backgroundColor: colors.card,
    padding: 12,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  stars: { fontSize: 18, color: colors.ink, letterSpacing: 2 },
  summary: { fontSize: 20, fontWeight: '700', color: colors.ink },
  text: { fontSize: 16, color: colors.ink },
  note: { fontSize: 14, color: colors.ink },
  muted: { color: colors.muted, fontSize: 14 },
  info: { color: '#2e7d32', fontSize: 15 },
  chip: {
    maxWidth: '100%',
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
