import { useEffect, useMemo, useState } from 'react';
import { BackHandler, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, Locale } from '../api';
import { addDays, calendarDate, dayTitle } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
import { weekStart, weekSummary, type WeekDay } from '../week';
import type { SalonChoice } from './SalonsScreen';

type WeekSelection = { from: string; action: 'open' | 'browse' | 'refresh' };
const BROWSE_DELAY_MS = 100;

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
  const { orgId, locationId, role } = salon;
  const [selection, select] = useState<WeekSelection>(() => ({
    from: weekStart(props.date),
    action: 'open',
  }));
  const { from, action } = selection;
  // Keep summaries and share in-flight reads only while browsing this salon's week screen.
  const cache = useMemo(
    () => ({
      days: new Map<string, WeekDay[]>(),
      pending: new Map<string, Promise<WeekDay[]>>(),
    }),
    [api, orgId, locationId, role],
  );
  const [result, setResult] = useState<{
    selection: WeekSelection;
    cache: typeof cache;
    days?: WeekDay[];
    failure?: { cause: unknown };
  } | null>(null);
  const cached = useMemo(() => cache.days.get(selection.from), [cache, selection]);
  const current = result?.selection === selection && result.cache === cache ? result : null;
  const shown = current?.days ?? cached ?? (result?.cache === cache ? result.days : undefined);
  const error = current?.failure ? errorText(current.failure.cause, t) : '';
  const loading = !current && (action === 'refresh' || !cached);
  const reload = () => select({ from, action: 'refresh' });

  useEffect(() => {
    if (action !== 'refresh' && cached) {
      setResult({ selection, cache, days: cached });
      return;
    }
    let active = true;
    // Coalesce rapid arrow taps before sending a range request.
    const timer = setTimeout(
      () => {
        const ready = cache.days.get(from);
        if (action !== 'refresh' && ready) {
          setResult({ selection, cache, days: ready });
          return;
        }
        let read = cache.pending.get(from);
        if (!read) {
          read = api
            .calendarRange(orgId, locationId, from, addDays(from, 6))
            .then((calendar) => {
              const days = weekSummary(calendar, from);
              cache.days.set(from, days);
              return days;
            })
            .finally(() => cache.pending.delete(from));
          cache.pending.set(from, read);
        }
        read.then(
          (days) => active && setResult({ selection, cache, days }),
          (cause: unknown) => {
            if (active) {
              setResult((previous) => ({
                selection,
                cache,
                days: cached ?? (previous?.cache === cache ? previous.days : undefined),
                failure: { cause },
              }));
            }
          },
        );
      },
      action === 'browse' ? BROWSE_DELAY_MS : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, orgId, locationId, cache, selection, from, action, cached]);

  // Android "back" closes the week instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const shownFrom = shown?.[0]?.date ?? from;
  const through = addDays(shownFrom, 6);
  const total = shown?.reduce((sum, d) => sum + d.visits, 0) ?? 0;

  return (
    <ScrollView
      contentContainerStyle={styles.screen}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
    >
      <View style={styles.top}>
        <Button kind="link" label={w.back} onPress={onBack} />
        <Text style={styles.salon}>{salon.locationName}</Text>
      </View>
      <View style={styles.row}>
        <Heading>{w.title}</Heading>
        <Text
          accessibilityLabel={`${dayTitle(shownFrom, props.locale)} – ${dayTitle(through, props.locale)}`}
          style={styles.muted}
        >
          {calendarDate(shownFrom, props.locale)}–{calendarDate(through, props.locale)}
        </Text>
      </View>
      <View style={styles.row}>
        <Button
          kind="secondary"
          compact
          label="‹"
          a11yLabel={w.previous}
          onPress={() => select(({ from }) => ({ from: addDays(from, -7), action: 'browse' }))}
        />
        <Button
          kind="secondary"
          compact
          label={w.thisWeek}
          onPress={() => select({ from: weekStart(today), action: 'browse' })}
          disabled={from === weekStart(today)}
        />
        <Button
          kind="secondary"
          compact
          label="›"
          a11yLabel={w.next}
          onPress={() => select(({ from }) => ({ from: addDays(from, 7), action: 'browse' }))}
        />
      </View>
      {error ? (
        <>
          <ErrorText>{error}</ErrorText>
          <Button kind="secondary" label={t.day.refresh} onPress={reload} />
        </>
      ) : null}
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
  top: {
    gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  salon: { color: colors.accent, fontWeight: '700', fontSize: 15, flexShrink: 1 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  section: { marginTop: 8, fontSize: 13, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  day: { fontSize: 17, fontWeight: '600', color: colors.ink },
  today: { fontWeight: '800' },
  visits: { color: colors.ink, fontSize: 15 },
});
