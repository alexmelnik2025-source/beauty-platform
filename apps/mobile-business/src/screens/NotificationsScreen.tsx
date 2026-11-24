import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, FlatList, Platform, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, Locale } from '../api';
import { dayTitle } from '../day';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { noticeKind, noticesOfSalon, opensVisit, type Notice } from '../notifications';
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
import type { SalonChoice } from './SalonsScreen';
import { VisitScreen } from './VisitScreen';
import {
  LoadingSkeleton,
  SalonReadCache,
  useScreenLifetime,
  withNetworkTimeout,
} from './HistoryScreen';

interface Inbox {
  notices: Notice[];
  newestId?: string;
}

let noticeCache = new SalonReadCache<Inbox>();

/**
 * The bell: new online bookings, visits added, moved or cancelled — in this salon, newest first.
 * Opening one marks it read and shows the visit card. Never client contacts (the server leaves them out).
 */
export function NotificationsScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  timeZone: string;
  canChange: boolean;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const n = t.notifications;
  const [list, setList] = useState<Notice[] | null>(() => noticeCache.peek(salon)?.notices ?? null);
  const shown = useRef<Notice[]>(list ?? []);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const lifetime = useScreenLifetime(salon);
  const latest = useRef(0);
  const refreshing = useRef(false);
  const load = useCallback(
    async (refresh = false) => {
      if (refresh && refreshing.current) return;
      const signal = lifetime.current!.signal;
      const request = ++latest.current;
      if (refresh) noticeCache.clear(salon);
      const cached = noticeCache.peek(salon);
      if (cached?.notices.length) {
        shown.current = cached.notices;
        setList(cached.notices);
        return;
      }
      refreshing.current = true;
      setError('');
      setLoading(true);
      try {
        // An empty salon inbox can gain a read or unread notice while it is closed.
        if (cached) {
          const newest = await withNetworkTimeout(api.notifications(1), signal).catch(() => null);
          if (signal.aborted || request !== latest.current) return;
          if (newest && newest[0]?.id === cached.newestId) {
            shown.current = cached.notices;
            setList(cached.notices);
            return;
          }
          noticeCache.clear(salon);
        }
        const { notices } = await noticeCache.read(
          salon,
          async () => {
            const all = await api.notifications(100);
            return {
              notices: noticesOfSalon(all, salon.orgId, salon.locationId),
              newestId: all[0]?.id,
            };
          },
          undefined,
          signal,
        );
        if (signal.aborted || request !== latest.current) return;
        shown.current = notices;
        setList(notices);
        setError('');
      } catch (e) {
        if (!signal.aborted && request === latest.current) setError(errorText(e, t));
      } finally {
        if (!signal.aborted && request === latest.current) {
          refreshing.current = false;
          setLoading(false);
        }
      }
    },
    [api, salon, lifetime, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (openId) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack, openId]);

  const marking = useRef(new Set<string>());
  const markRead = useCallback(
    async (id?: string) => {
      const key = id ?? 'all';
      if (marking.current.has(key) || marking.current.has('all')) return;
      marking.current.add(key);
      const signal = lifetime.current!.signal;
      try {
        await withNetworkTimeout(api.markNotificationsRead(id ? { ids: [id] } : { all: true }));
        // The all endpoint also marks notifications of the user's other salons.
        if (!id) noticeCache = new SalonReadCache<Inbox>();
        if (signal.aborted) {
          noticeCache.clear(salon);
          return;
        }
        ++latest.current;
        refreshing.current = false;
        setLoading(false);
        const updated = shown.current.map((item) =>
          !item.read && (!id || item.id === id) ? { ...item, read: true } : item,
        );
        shown.current = updated;
        noticeCache.set(salon, { notices: updated });
        setList(updated);
        setError('');
      } catch (e) {
        if (!signal.aborted) setError(errorText(e, t));
      } finally {
        marking.current.delete(key);
      }
    },
    [api, lifetime, salon, t],
  );

  const open = useCallback(
    (notice: Notice) => {
      if (!notice.read) void markRead(notice.id);
      if (opensVisit(notice)) setOpenId(notice.appointmentId);
    },
    [markRead],
  );

  const { locale } = props;
  const renderItem = useCallback(
    ({ item }: { item: Notice }) => <NoticeRow notice={item} t={t} locale={locale} open={open} />,
    [t, locale, open],
  );

  if (openId) {
    return (
      <VisitScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        id={openId}
        timeZone={props.timeZone}
        canChange={props.canChange}
        onBack={() => setOpenId(null)}
        onChanged={() => undefined}
      />
    );
  }

  const unread = list?.some((x) => !x.read) ?? false;
  return (
    <FlatList
      role="list"
      accessibilityLabel={n.title}
      data={list ?? []}
      renderItem={renderItem}
      contentContainerStyle={styles.screen}
      refreshing={loading && list !== null}
      onRefresh={() => void load(true)}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.row}>
            <Button kind="link" label={n.back} onPress={onBack} />
          </View>
          <Heading>{n.title}</Heading>
          {unread ? (
            <View style={styles.row}>
              <Button kind="secondary" label={n.readAll} onPress={() => void markRead()} />
            </View>
          ) : null}
          {error ? <ErrorText>{error}</ErrorText> : null}
          {error || (Platform.OS === 'web' && list?.length) ? (
            <Button
              kind="secondary"
              label={t.day.refresh}
              disabled={loading}
              onPress={() => void load(true)}
            />
          ) : null}
        </View>
      }
      ListEmptyComponent={
        list ? (
          <Text style={styles.muted}>{n.empty}</Text>
        ) : !error ? (
          <LoadingSkeleton label={t.loading} />
        ) : undefined
      }
    />
  );
}

const NoticeRow = memo(function NoticeRow({
  notice,
  t,
  locale,
  open,
}: {
  notice: Notice;
  t: Dictionary;
  locale: Locale;
  open: (notice: Notice) => void;
}) {
  const n = t.notifications;
  const kind = n.kind[noticeKind(notice)];
  const source = notice.data.by === 'client' ? n.byClient : n.bySalon;
  const date = dayTitle(notice.data.date, locale);
  const detail = `${notice.data.customerName ?? t.day.walkIn} · ${notice.data.serviceName} · ${notice.data.staffName}`;
  const label = `${kind}, ${notice.data.time} ${detail}, ${date}, ${source}`;
  const content = (
    <View aria-hidden>
      <Card>
        <View style={styles.top}>
          <Text style={[styles.kind, notice.type === 'appointment.cancelled' && styles.bad]}>
            {notice.read ? '' : '● '}
            {kind}
          </Text>
          <Text style={styles.small}>{source}</Text>
        </View>
        <Text style={styles.value}>
          {date}, {notice.data.time}
        </Text>
        <Text style={styles.muted}>{detail}</Text>
      </Card>
    </View>
  );
  if (notice.read && !opensVisit(notice)) {
    return (
      <View accessible role="listitem" accessibilityLabel={label}>
        {content}
      </View>
    );
  }
  return (
    <View role="listitem">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={Platform.OS === 'web' && !notice.read ? `${n.unread}: ${label}` : label}
        accessibilityValue={Platform.OS !== 'web' && !notice.read ? { text: n.unread } : undefined}
        onPress={() => open(notice)}
        style={({ pressed }) => pressed && { opacity: 0.7 }}
      >
        {content}
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  header: { gap: 12 },
  screen: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  top: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  kind: { fontSize: 15, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  bad: { color: colors.danger },
  value: { fontSize: 17, color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
  small: { flexShrink: 1, color: colors.muted, fontSize: 13 },
});
