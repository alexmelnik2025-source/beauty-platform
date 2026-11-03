import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, Calendar, Locale } from '../api';
import { addDays, dayTitle, staffOfDay, todayIn, visitsOfDay } from '../day';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

const REFRESH_MS = 30_000;

/** One day of the salon's calendar; a specialist sees their own visits (the server decides). */
export function DayScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  timeZone: string;
  canChangeSalon: boolean;
  onChangeSalon: () => void;
  onSignOut: () => void;
}) {
  const { api, t, salon } = props;
  const today = todayIn(props.timeZone);
  const [date, setDate] = useState(today);
  const [calendar, setCalendar] = useState<Calendar | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCalendar(await api.calendar(salon.orgId, salon.locationId, date));
      setError('');
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setLoading(false);
    }
  }, [api, salon, date, t]);

  useEffect(() => {
    setCalendar(null);
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const visits = calendar && calendar.from === date ? visitsOfDay(calendar, date) : null;
  const working = calendar && calendar.from === date ? staffOfDay(calendar, date) : [];

  return (
    <ScrollView
      contentContainerStyle={styles.screen}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
    >
      <View style={styles.top}>
        <Text style={styles.salon}>{salon.locationName}</Text>
        <View style={styles.row}>
          {props.canChangeSalon ? (
            <Button kind="link" label={t.changeSalon} onPress={props.onChangeSalon} />
          ) : null}
          <Button kind="link" label={t.signOut} onPress={props.onSignOut} />
        </View>
      </View>

      <Heading>{dayTitle(date, props.locale)}</Heading>
      <View style={styles.row}>
        <Button
          kind="secondary"
          label="‹"
          a11yLabel={t.day.previous}
          onPress={() => setDate(addDays(date, -1))}
        />
        <Button
          kind="secondary"
          label={t.day.today}
          onPress={() => setDate(today)}
          disabled={date === today}
        />
        <Button
          kind="secondary"
          label="›"
          a11yLabel={t.day.next}
          onPress={() => setDate(addDays(date, 1))}
        />
        <Button kind="link" label={t.day.refresh} onPress={load} />
      </View>
      {error ? <ErrorText>{error}</ErrorText> : null}

      {visits ? (
        <>
          <Text style={styles.section}>{t.day.working}</Text>
          <Text style={styles.muted}>
            {working.length === 0
              ? t.day.nobodyWorks
              : working.map((w) => `${w.name} ${w.hours}`).join(' · ')}
          </Text>

          <Text style={styles.section}>
            {t.day.visits} ({visits.length})
          </Text>
          {visits.length === 0 ? <Text style={styles.muted}>{t.day.empty}</Text> : null}
          {visits.map((v) => (
            <Card key={v.id}>
              <View style={styles.cardTop}>
                <Text style={styles.time}>
                  {v.start}–{v.end}
                </Text>
                <Text style={[styles.badge, v.status === 'no_show' && styles.badgeBad]}>
                  {t.day.status[v.status as keyof Dictionary['day']['status']] ?? v.status}
                </Text>
              </View>
              <Text style={styles.customer}>{v.customer ?? t.day.walkIn}</Text>
              <Text style={styles.muted}>
                {v.service} · {v.staff}
              </Text>
              {v.phone ? <Text style={styles.muted}>{v.phone}</Text> : null}
            </Card>
          ))}
        </>
      ) : !error ? (
        <Text style={styles.muted}>{t.loading}</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  salon: { color: colors.gold, fontWeight: '700', fontSize: 15, flexShrink: 1 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  section: { marginTop: 8, fontSize: 13, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  muted: { color: colors.muted, fontSize: 15 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  time: { fontSize: 18, fontWeight: '700', color: colors.ink },
  badge: {
    fontSize: 12,
    color: colors.ink,
    backgroundColor: '#efe7d8',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
  badgeBad: { backgroundColor: '#f6dcd9', color: colors.danger },
  customer: { fontSize: 17, fontWeight: '600', color: colors.ink },
});
