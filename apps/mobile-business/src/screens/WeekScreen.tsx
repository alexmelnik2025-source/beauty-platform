import { useCallback, useEffect, useRef, useState } from 'react';
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
import { addDays, dayTitle } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import { weekStart, weekSummary, type WeekDay } from '../week';
import type { SalonChoice } from './SalonsScreen';

/**
 * "Tydzień" (task 214): Monday to Sunday at a glance — how many visits each day has, from when
 * to when, who works. Tapping a day opens it. A specialist sees only their own visits (the
 * server decides, as on the day screen).
 */
export function WeekScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  /** The day the screen was opened from: its week is shown first. */
  date: string;
  today: string;
  onOpenDay: (date: string) => void;
  onBack: () => void;
}) {
  const { api, t, salon, today, onBack } = props;
  const w = t.week;
  const [from, setFrom] = useState(weekStart(props.date));
  const [days, setDays] = useState<{ from: string; list: WeekDay[] } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Only the newest answer is shown: tapping through weeks quickly must not leave an older one.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    try {
      const calendar = await api.calendarRange(
        salon.orgId,
        salon.locationId,
        from,
        addDays(from, 6),
      );
      if (request !== latest.current) return;
      setDays({ from, list: weekSummary(calendar, from) });
      setError('');
    } catch (e) {
      if (request === latest.current) setError(errorText(e, t));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [api, salon, from, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Android "back" closes the week instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const shown = days && days.from === from ? days.list : null;
  const total = shown?.reduce((sum, d) => sum + d.visits, 0) ?? 0;

  return (
    <ScrollView
      contentContainerStyle={styles.screen}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
    >
      <View style={styles.top}>
        <Button kind="link" label={w.back} onPress={onBack} />
        <Text style={styles.salon}>{salon.locationName}</Text>
      </View>
      <Heading>{w.title}</Heading>
      <Text style={styles.muted}>
        {dayTitle(from, props.locale)} – {dayTitle(addDays(from, 6), props.locale)}
      </Text>
      <View style={styles.row}>
        <Button
          kind="secondary"
          label="‹"
          a11yLabel={w.previous}
          onPress={() => setFrom(addDays(from, -7))}
        />
        <Button
          kind="secondary"
          label={w.thisWeek}
          onPress={() => setFrom(weekStart(today))}
          disabled={from === weekStart(today)}
        />
        <Button
          kind="secondary"
          label="›"
          a11yLabel={w.next}
          onPress={() => setFrom(addDays(from, 7))}
        />
      </View>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {shown ? (
        <>
          <Text style={styles.section}>{fill(w.total, { n: String(total) })}</Text>
          {shown.map((d) => {
            const parts = [
              d.visits > 0 ? fill(w.visits, { n: String(d.visits) }) : w.free,
              d.span,
              d.waiting > 0 ? `⏳ ${fill(w.waiting, { n: String(d.waiting) })}` : null,
              d.working > 0 ? fill(w.working, { n: String(d.working) }) : w.closed,
            ].filter(Boolean);
            const title = `${dayTitle(d.date, props.locale)}${d.date === today ? ` · ${w.today}` : ''}`;
            return (
              <Pressable
                key={d.date}
                accessibilityRole="button"
                accessibilityLabel={`${title}: ${parts.join(' · ')}`}
                onPress={() => props.onOpenDay(d.date)}
                style={({ pressed }) => pressed && { opacity: 0.7 }}
              >
                <Card>
                  <Text style={[styles.day, d.date === today && styles.today]}>{title}</Text>
                  <Text style={d.visits > 0 ? styles.visits : styles.muted}>
                    {parts.join(' · ')}
                  </Text>
                </Card>
              </Pressable>
            );
          })}
          <Text style={styles.small}>{w.hint}</Text>
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
  salon: { color: colors.accent, fontWeight: '700', fontSize: 15, flexShrink: 1 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  section: { marginTop: 8, fontSize: 13, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  day: { fontSize: 17, fontWeight: '600', color: colors.ink },
  today: { fontWeight: '800' },
  visits: { color: colors.ink, fontSize: 15 },
});
