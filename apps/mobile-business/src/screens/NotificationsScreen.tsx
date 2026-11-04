import { useCallback, useEffect, useState } from 'react';
import {
  BackHandler,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { BusinessApi, Locale } from '../api';
import { dayTitle } from '../day';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { noticeKind, noticesOfSalon, opensVisit, type Notice } from '../notifications';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';
import { VisitScreen } from './VisitScreen';

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
  const [list, setList] = useState<Notice[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList(noticesOfSalon(await api.notifications(100), salon.orgId, salon.locationId));
      setError('');
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setLoading(false);
    }
  }, [api, salon, t]);

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

  async function open(notice: Notice) {
    if (!notice.read) {
      setList((current) =>
        current ? current.map((x) => (x.id === notice.id ? { ...x, read: true } : x)) : current,
      );
      void api.markNotificationsRead({ ids: [notice.id] }).catch(() => undefined);
    }
    if (opensVisit(notice)) setOpenId(notice.appointmentId);
  }

  async function readAll() {
    try {
      await api.markNotificationsRead({ all: true });
      await load();
    } catch (e) {
      setError(errorText(e, t));
    }
  }

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
    <ScrollView
      contentContainerStyle={styles.screen}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
    >
      <View style={styles.row}>
        <Button kind="link" label={n.back} onPress={onBack} />
      </View>
      <Heading>{n.title}</Heading>
      {unread ? (
        <View style={styles.row}>
          <Button kind="secondary" label={n.readAll} onPress={() => void readAll()} />
        </View>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {list === null ? (
        !error ? (
          <Text style={styles.muted}>{t.loading}</Text>
        ) : null
      ) : list.length === 0 ? (
        <Text style={styles.muted}>{n.empty}</Text>
      ) : (
        list.map((notice) => {
          const kind = n.kind[noticeKind(notice)];
          return (
            <Pressable
              key={notice.id}
              accessibilityRole="button"
              accessibilityLabel={`${notice.read ? '' : `${n.unread}: `}${kind}, ${notice.data.time} ${notice.data.customerName ?? t.day.walkIn}`}
              onPress={() => void open(notice)}
              style={({ pressed }) => pressed && { opacity: 0.7 }}
            >
              <Card>
                <View style={styles.top}>
                  <Text
                    style={[styles.kind, notice.type === 'appointment.cancelled' && styles.bad]}
                  >
                    {notice.read ? '' : '● '}
                    {kind}
                  </Text>
                  <Text style={styles.small}>
                    {notice.data.by === 'client' ? n.byClient : n.bySalon}
                  </Text>
                </View>
                <Text style={styles.value}>
                  {dayTitle(notice.data.date, props.locale)}, {notice.data.time}
                </Text>
                <Text style={styles.muted}>
                  {notice.data.customerName ?? t.day.walkIn} · {notice.data.serviceName} ·{' '}
                  {notice.data.staffName}
                </Text>
              </Card>
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  kind: { fontSize: 15, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  bad: { color: colors.danger },
  value: { fontSize: 17, color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
});
