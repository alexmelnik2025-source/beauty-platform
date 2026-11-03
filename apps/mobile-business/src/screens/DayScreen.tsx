import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, Calendar, Locale } from '../api';
import { addDays, dayTitle, myStaffId, onlyMine, staffOfDay, todayIn, visitsOfDay } from '../day';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';
import { VisitScreen } from './VisitScreen';

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
  const [openId, setOpenId] = useState<string | null>(null);
  const [canChange, setCanChange] = useState(salon.role !== 'staff');
  const [mineId, setMineId] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);

  // Once per salon: may this person mark visits, and are they one of the specialists?
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [perms, me, staff] = await Promise.allSettled([
        api.permissions(salon.orgId),
        api.me(),
        api.staff(salon.orgId, salon.locationId),
      ]);
      if (!alive) return;
      if (perms.status === 'fulfilled') {
        const p = perms.value.me;
        setCanChange(p.role !== 'staff' || p.permissions.changeOwnAppointments);
      }
      if (me.status === 'fulfilled' && staff.status === 'fulfilled') {
        setMineId(myStaffId(staff.value, me.value.user.id));
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, salon]);

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

  const all = calendar && calendar.from === date ? visitsOfDay(calendar, date) : null;
  // "Only mine" is for an owner or manager who also works as a specialist;
  // a specialist's calendar already holds just their own visits (the server decides).
  const showMineSwitch = salon.role !== 'staff' && mineId !== null;
  const visits = all && showMineSwitch && mineOnly ? onlyMine(all, mineId) : all;

  if (openId) {
    return (
      <VisitScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        id={openId}
        timeZone={props.timeZone}
        canChange={canChange}
        onBack={() => setOpenId(null)}
        onChanged={() => void load()}
      />
    );
  }
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

          <View style={[styles.row, styles.sectionRow]}>
            <Text style={styles.section}>
              {t.day.visits} ({visits.length})
            </Text>
            {showMineSwitch ? (
              <Button
                kind="link"
                label={mineOnly ? t.day.everyone : t.day.onlyMine}
                onPress={() => setMineOnly(!mineOnly)}
              />
            ) : null}
          </View>
          {visits.length === 0 ? <Text style={styles.muted}>{t.day.empty}</Text> : null}
          {visits.map((v) => (
            <Pressable
              key={v.id}
              accessibilityRole="button"
              accessibilityLabel={`${v.start} ${v.customer ?? t.day.walkIn} · ${v.service}`}
              onPress={() => setOpenId(v.id)}
              style={({ pressed }) => pressed && { opacity: 0.7 }}
            >
              <Card>
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
            </Pressable>
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
  sectionRow: { justifyContent: 'space-between', marginTop: 8 },
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
