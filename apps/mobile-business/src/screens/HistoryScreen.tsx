import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, FlatList, StyleSheet, Text, View } from 'react-native';
import type { AuditLog, BusinessApi, Locale } from '../api';
import { errorText } from '../errors';
import { appendPage, historyLine, historyTitle, type HistoryEntry } from '../history';
import type { Dictionary } from '../i18n';
import { Button, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

// App creates fresh SalonChoice objects on sign-in, even for the same location.
// A weak key therefore keeps short-lived reads inside the selected account.
export class SalonReadCache<T> {
  private entries = new WeakMap<
    SalonChoice,
    { key: string; expires: number; result: Promise<T> }
  >();

  read(salon: SalonChoice, fetchValue: () => Promise<T>, key = ''): Promise<T> {
    const current = this.entries.get(salon);
    if (current && current.key === key && current.expires > Date.now()) return current.result;
    const entry = { key, expires: Infinity, result: fetchValue() };
    this.entries.set(salon, entry);
    entry.result.then(
      () => {
        entry.expires = Date.now() + 60_000;
      },
      () => {
        if (this.entries.get(salon) === entry) this.clear(salon);
      },
    );
    return entry.result;
  }

  set(salon: SalonChoice, value: T, key = '') {
    this.entries.set(salon, { key, expires: Date.now() + 60_000, result: Promise.resolve(value) });
  }

  clear(salon: SalonChoice) {
    this.entries.delete(salon);
  }
}

// Capture the signal before awaiting: a later mount or filter gets a different lifetime.
export function useScreenLifetime(salon: SalonChoice, key = '') {
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, [salon, key]);
  return lifetime;
}

export function LoadingSkeleton({ label }: { label: string }) {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={styles.skeleton}
    >
      <View style={styles.skeletonLine} />
      <View style={[styles.skeletonLine, { width: '60%' }]} />
    </View>
  );
}

const historyCache = new SalonReadCache<AuditLog>();
const HistoryRow = memo(function HistoryRow({
  entry,
  t,
  locale,
  timeZone,
}: {
  entry: HistoryEntry;
  t: Dictionary;
  locale: Locale;
  timeZone: string;
}) {
  const title = historyTitle(entry, t);
  const detail = historyLine(entry, t, locale, timeZone);
  return (
    <View accessible role="listitem" accessibilityLabel={`${title}. ${detail}`} style={styles.row}>
      <Text aria-hidden style={styles.title}>
        {title}
      </Text>
      <Text aria-hidden style={styles.muted}>
        {detail}
      </Text>
    </View>
  );
});

/**
 * Task 150: "Dziennik zmian" — the owner sees on the phone who changed services, the team,
 * schedules, rights, clients, loyalty and settings, and when. Newest first, 50 at a time.
 */
export function HistoryScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  timeZone: string;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const h = t.history;
  const [page, setPage] = useState<AuditLog | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const lifetime = useScreenLifetime(salon);

  useEffect(() => {
    const signal = lifetime.current!.signal;
    historyCache
      .read(salon, () => api.auditLog(salon.orgId))
      .then(
        (result) => {
          if (!signal.aborted) setPage(result);
        },
        (e) => {
          if (!signal.aborted) setFailure(e);
        },
      );
  }, [api, salon, lifetime]);

  async function more() {
    if (!page?.next || pending.current) return;
    const signal = lifetime.current!.signal;
    pending.current = true;
    setBusy(true);
    try {
      const result = await api.auditLog(salon.orgId, page.next);
      if (signal.aborted) return;
      const merged = { ...result, items: appendPage(page.items, result.items) };
      historyCache.set(salon, merged);
      setPage(merged);
      setFailure(null);
    } catch (e) {
      if (!signal.aborted) setFailure(e);
    } finally {
      pending.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  const { locale, timeZone } = props;
  const renderItem = useCallback(
    ({ item }: { item: HistoryEntry }) => (
      <HistoryRow entry={item} t={t} locale={locale} timeZone={timeZone} />
    ),
    [t, locale, timeZone],
  );

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
      role="list"
      accessibilityLabel={h.title}
      contentContainerStyle={styles.screen}
      data={page?.items ?? []}
      renderItem={renderItem}
      ListHeaderComponent={
        <View style={styles.header}>
          <Button kind="link" label={h.back} onPress={onBack} />
          <Heading>{h.title}</Heading>
          {page?.items.length ? <Text style={styles.muted}>{h.hint}</Text> : null}
          {failure ? <ErrorText>{errorText(failure, t)}</ErrorText> : null}
        </View>
      }
      ListEmptyComponent={
        page ? (
          <Text style={styles.muted}>{h.empty}</Text>
        ) : !failure ? (
          <LoadingSkeleton label={t.loading} />
        ) : undefined
      }
      ListFooterComponent={
        busy ? (
          <LoadingSkeleton label={t.loading} />
        ) : page?.next ? (
          <Button kind="secondary" label={h.more} onPress={more} />
        ) : undefined
      }
    />
  );
}

const styles = StyleSheet.create({
  skeleton: { backgroundColor: colors.card, borderRadius: 12, padding: 16, gap: 12 },
  skeletonLine: { backgroundColor: colors.soft, height: 14, borderRadius: 4 },
  screen: { padding: 20 },
  header: { gap: 12, marginBottom: 12 },
  row: {
    backgroundColor: colors.card,
    padding: 12,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  title: { fontSize: 16, fontWeight: '600', color: colors.ink },
  muted: { color: colors.muted, fontSize: 14 },
});
