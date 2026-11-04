import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  addDays,
  ApiError,
  todayIn,
  type ClientApi,
  type Locale,
  type PublicLocation,
} from '../api';
import { errorText } from '../errors';
import { dayChip, formatDay } from '../format';
import { fill, type Dictionary } from '../i18n';
import { Button, colors, ErrorText } from '../ui';

/** The waiting list offers this many days (salons take bookings at least that far ahead). */
export const WAITLIST_DAYS = 14;

/**
 * Under the free times: "No time that suits you? Tell me when one frees up". The signed-in
 * client picks any day (also a full one) and gets one email when a time frees up then.
 */
export function WaitlistPanel(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  salon: PublicLocation;
  serviceId: string;
  /** undefined = any specialist. */
  staffId?: string;
  signedIn: boolean;
}) {
  const { api, t, locale, salon } = props;
  const w = t.waitlist;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [joined, setJoined] = useState<string | null>(null);
  const [error, setError] = useState('');

  if (!open) {
    return <Button kind="link" label={w.open} onPress={() => setOpen(true)} />;
  }
  if (!props.signedIn) return <Text style={styles.muted}>{w.signInFirst}</Text>;

  const today = todayIn(salon.timezone);
  const days = Array.from({ length: WAITLIST_DAYS }, (_, i) => addDays(today, i));

  const join = async (date: string) => {
    setBusy(date);
    setError('');
    try {
      await api.joinWaitlist({
        slug: salon.slug,
        serviceId: props.serviceId,
        ...(props.staffId ? { staffId: props.staffId } : {}),
        date,
      });
      setJoined(date);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'TOO_MANY_WAITLIST' ? w.tooMany : errorText(e, t),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.panel}>
      <Text role="heading" aria-level={3} style={styles.title}>
        {w.title}
      </Text>
      <Text style={styles.muted}>{w.lead}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.days}
      >
        {days.map((date) => {
          const chip = dayChip(date, locale);
          const on = date === joined;
          return (
            <Pressable
              key={date}
              accessibilityRole="button"
              accessibilityLabel={`${w.title}: ${formatDay(date, locale)}`}
              aria-pressed={on}
              disabled={busy !== null}
              onPress={() => void join(date)}
              style={[styles.day, on && styles.dayOn, busy === date && { opacity: 0.6 }]}
            >
              <Text style={[styles.week, on && styles.onText]}>{chip.weekday}</Text>
              <Text style={[styles.number, on && styles.onText]}>{chip.day}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {joined ? (
        <Text role="status" style={styles.ok}>
          {fill(w.joined, { day: formatDay(joined, locale) })}
        </Text>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: 12,
    marginTop: 4,
  },
  title: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  ok: { color: '#1e6b3a', fontSize: 14, lineHeight: 20 },
  days: { gap: 8, paddingVertical: 2 },
  day: {
    width: 52,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: 'center',
  },
  dayOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  week: { color: colors.muted, fontSize: 12, textTransform: 'capitalize' },
  number: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  onText: { color: '#fff' },
});
