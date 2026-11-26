import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ApiError,
  type BusinessApi,
  type Locale,
  type ReviewSettings,
  type SalonReviews,
} from '../api';
import { errorText } from '../errors';
import { useFormDraft } from '../formDrafts';
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
import { SalonReadCache, useScreenLifetime, withNetworkTimeout } from './HistoryScreen';

// Store completed pages for each filter only for the current salon session.
const reviewsCache = new WeakMap<
  SalonChoice,
  Map<string, { value: SalonReviews; unansweredOnly: boolean; expires: number }>
>();
const pendingReplies = new WeakMap<SalonChoice, Map<string, Promise<Review>>>();
function recentPages(salon: SalonChoice) {
  let pages = reviewsCache.get(salon);
  if (!pages) {
    pages = new Map();
    reviewsCache.set(salon, pages);
  }
  const now = Date.now();
  for (const [key, entry] of pages) if (entry.expires <= now) pages.delete(key);
  return pages;
}
function withReply(page: SalonReviews, saved: Review, unansweredOnly: boolean) {
  const previous = page.items.find((item) => item.id === saved.id);
  if (!previous) return;
  return {
    ...page,
    unanswered: Math.max(0, page.unanswered + Number(!saved.reply) - Number(!previous.reply)),
    items:
      unansweredOnly && saved.reply
        ? page.items.filter((item) => item.id !== saved.id)
        : page.items.map((item) => (item.id === saved.id ? saved : item)),
  };
}

function cacheReply(salon: SalonChoice, saved: Review) {
  const pages = new Map(recentPages(salon));
  for (const [key, entry] of pages) {
    const value = withReply(entry.value, saved, entry.unansweredOnly);
    if (value) pages.set(key, { ...entry, value });
    else pages.delete(key); // The filtered count or an unloaded page may have changed.
  }
  reviewsCache.set(salon, pages);
}
const settingsCache = new SalonReadCache<ReviewSettings>();
type ReplyEditor = {
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
      const file = await withNetworkTimeout(
        api.reviewsCsv(salon.orgId, salon.locationId, props.locale, {
          staffId: staffId ?? undefined,
          serviceId: serviceId ?? undefined,
          rating: rating ?? undefined,
          unanswered,
        }),
      );
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
  const [failure, setFailure] = useState<{ message: string; older: boolean } | null>(null);
  const displayedFilter = useRef({ key, unanswered });
  const load = useCallback(
    async (previous?: SalonReviews) => {
      if (previous && (request.current || !previous.nextBefore)) return;
      const signal = lifetime.current!.signal;
      const id = Symbol();
      request.current = id;
      setBusy(true);
      setFailure(null);
      try {
        // On return, an earlier editor may still be publishing. Read the
        // updated list and draft together before mounting any reply editors.
        const pending = pendingReplies.get(salon);
        if (!displayed.current && pending?.size) {
          await Promise.allSettled(pending.values());
          if (signal.aborted || request.current !== id) return;
        }
        let pages = recentPages(salon);
        let cached = previous ? undefined : pages.get(key);
        let result: SalonReviews;
        // A write can finish while an older GET is in flight. Read from the new
        // cache generation (or retry the affected page) before displaying it.
        for (;;) {
          result =
            cached?.value ??
            (await withNetworkTimeout(
              api.reviews(
                salon.orgId,
                salon.locationId,
                {
                  before: previous?.nextBefore ?? undefined,
                  staffId: staffId ?? undefined,
                  serviceId: serviceId ?? undefined,
                  rating: rating ?? undefined,
                  unanswered,
                },
                signal,
              ),
              signal,
            ));
          if (signal.aborted || request.current !== id) return;
          const latest = recentPages(salon);
          if (pages === latest) break;
          pages = latest;
          cached = previous ? undefined : pages.get(key);
        }
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
        if (!cached)
          pages.set(key, {
            value: merged,
            unansweredOnly: unanswered,
            expires: Date.now() + 60_000,
          });
        displayedFilter.current = { key, unanswered };
        show(merged);
      } catch (e) {
        if (!signal.aborted && request.current === id) {
          setFailure({ message: errorText(e, t), older: Boolean(previous) });
        }
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
    setCsvInfo('');
    setCsvBusy(false);
    void load();
  }, [load]);

  const edit = useCallback((id: string, editor?: ReplyEditor) => {
    setEditors((current) => ({ ...current, [id]: editor }));
  }, []);
  const screen = useScreenLifetime(salon);
  const reply = useCallback(
    async (review: Review, value: string | null, editor: ReplyEditor, onSaved: () => void) => {
      let pending = pendingReplies.get(salon);
      if (pending?.has(review.id)) return;
      if (!pending) {
        pending = new Map();
        pendingReplies.set(salon, pending);
      }
      const signal = screen.current!.signal;
      edit(review.id, { ...editor, busy: true, error: undefined });
      try {
        const write = withNetworkTimeout(
          value === null
            ? api.removeReviewReply(salon.orgId, salon.locationId, review.id)
            : api.replyToReview(salon.orgId, salon.locationId, review.id, value),
        ).then((saved) => {
          cacheReply(salon, saved);
          onSaved();
          return saved;
        });
        pending.set(review.id, write);
        const saved = await write;
        if (signal.aborted) return;
        edit(review.id);
        const current = displayed.current;
        const filter = displayedFilter.current;
        if (current) {
          const updated =
            recentPages(salon).get(filter.key)?.value ??
            withReply(current, saved, filter.unanswered);
          if (updated) show(updated);
        }
      } catch (e) {
        if (!signal.aborted) edit(review.id, { ...editor, busy: false, error: errorText(e, t) });
      } finally {
        pending.delete(review.id);
      }
    },
    [api, salon, screen, edit, show, t],
  );
  const settingsSaved = useCallback(
    (enabled: boolean) => {
      // Saving collection settings invalidates the list, including a previously empty page.
      if (displayed.current) show({ ...displayed.current, enabled });
    },
    [show],
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
          {failure ? (
            <>
              <ErrorText>{failure.message}</ErrorText>
              <Button
                kind="secondary"
                label={t.day.refresh}
                onPress={() => void load(failure.older && page ? page : undefined)}
              />
            </>
          ) : null}
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
          {csvInfo ? <ErrorText>{csvInfo}</ErrorText> : null}
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
        failure ? undefined : !page || busy ? (
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
        displayedFilter.current.key === key && page?.nextBefore && !failure ? (
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
  reply: (
    review: Review,
    value: string | null,
    editor: ReplyEditor,
    onSaved: () => void,
  ) => Promise<void>;
}) {
  const { review, t } = props;
  const [draft, setDraft] = useFormDraft<string | null>(`reviews.${review.id}.reply`, null);
  const editor = props.editor ?? { editing: props.manager && draft !== null };
  const { editing, busy, error } = editor;
  const text = draft ?? review.reply ?? '';
  const r = t.reviews;
  const line = useMemo(
    () => reviewLine(review, t, props.locale, props.timeZone),
    [review, t, props.locale, props.timeZone],
  );
  const missingText = Boolean(editor.missingText);
  const fieldError = missingText ? r.reply : error;
  const errorId = `reply-error-${review.id}`;
  function submit(value: string | null) {
    void props.reply(review, value, editor, () => {
      // A manager can leave and start a newer draft before this request finishes.
      setDraft((current) => (current === draft ? null : current));
    });
  }
  function publish() {
    const value = text.trim();
    if (!value) {
      props.edit(review.id, { ...editor, missingText: true, error: undefined });
      return;
    }
    submit(value);
  }
  return (
    <View role="group" accessibilityLabel={line} style={styles.row}>
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
            editable={!busy}
            value={text}
            onChangeText={(text) => {
              setDraft(text);
              if (error || (missingText && text.trim())) {
                props.edit(review.id, {
                  ...editor,
                  missingText: missingText && !text.trim(),
                  error: undefined,
                });
              }
            }}
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
            disabled={busy}
            label={r.replyCancel}
            onPress={() => {
              setDraft(null);
              props.edit(review.id);
            }}
          />
        </View>
      ) : props.manager ? (
        <View style={styles.actions}>
          <Button
            kind="secondary"
            disabled={busy}
            label={review.reply ? r.replyChange : r.reply}
            onPress={() => props.edit(review.id, { ...editor, editing: true })}
          />
          {review.reply ? (
            <Button kind="link" label={r.replyRemove} busy={busy} onPress={() => submit(null)} />
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
    const current = await settingsCache.read(
      salon,
      () => api.reviewSettings(salon.orgId, salon.locationId, signal),
      '',
      signal,
    );
    if (signal.aborted) return;
    setSaved(current);
    setForm(current);
  }, [api, salon, lifetime]);

  const loadSettings = useCallback(() => {
    const signal = lifetime.current!.signal;
    setNote(null);
    load().catch((e) => {
      if (!signal.aborted) setNote({ text: errorText(e, t), bad: true });
    });
  }, [load, t, lifetime]);

  useEffect(loadSettings, [loadSettings]);

  if (!saved || !form) {
    return note ? (
      <Card>
        <Text style={styles.replyTitle}>{r.settings}</Text>
        <ErrorText>{note.text}</ErrorText>
        <Button kind="secondary" label={t.day.refresh} onPress={loadSettings} />
      </Card>
    ) : null;
  }

  async function save() {
    if (!form) return;
    const signal = lifetime.current!.signal;
    setBusy(true);
    setNote(null);
    try {
      const done = await withNetworkTimeout(
        api.saveReviewSettings(salon.orgId, salon.locationId, form),
      );
      settingsCache.set(salon, done);
      reviewsCache.delete(salon);
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
      <View role="group" accessibilityLabel={r.settings} style={styles.actions}>
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
          <View role="group" accessibilityLabel={r.askAfter} style={styles.actions}>
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
