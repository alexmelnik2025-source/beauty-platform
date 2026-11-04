import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, todayIn, type ClientApi, type Locale, type PublicLocation } from '../api';
import { BOOKING_DAYS } from '../booking';
import { errorText } from '../errors';
import { dayChip, formatDay } from '../format';
import { fill, type Dictionary } from '../i18n';
import { Button, colors, ErrorText } from '../ui';
import { waitlistDays } from '../waitlist';

/** The waiting list's words for the API's refusals (task 50 rules). */
function waitlistErrorText(error: unknown, t: Dictionary): string {
  if (error instanceof ApiError) {
    if (error.code === 'WAITLIST_LIMIT') return t.waitlist.tooMany;
    if (error.code === 'SLOTS_AVAILABLE') return t.waitlist.slotsAvailable;
    if (error.code === 'WAITLIST_DATE') return t.waitlist.badDay;
  }
  return errorText(error, t);
}

/**
 * Task 51: under the free times — "No day that suits you? Tell me when a time frees up". The
 * signed-in client picks a day without free times and gets one email (to the email they signed
 * in with) when a time frees up then. Not signed in: the web booking page has the same form.
 */
export function WaitlistPanel(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  salon: PublicLocation;
  serviceId: string;
  /** undefined = any specialist. */
  staffId?: string;
  /** The days that have free times (they are booked, not waited for). */
  freeDates: string[];
  signedIn: boolean;
}) {
  const { api, t, locale, salon } = props;
  const w = t.waitlist;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [joined, setJoined] = useState<string | null>(null);
  const [error, setError] = useState('');

  if (!open) return <Button kind="link" label={w.open} onPress={() => setOpen(true)} />;
  if (!props.signedIn) return <Text style={styles.muted}>{w.signInFirst}</Text>;

  const days = waitlistDays(todayIn(salon.timezone), props.freeDates, BOOKING_DAYS);

  const join = async (date: string) => {
    if (!name.trim()) {
      setError(w.nameNeeded);
      return;
    }
    setBusy(date);
    setError('');
    try {
      await api.joinWaitlist(salon.slug, {
        serviceId: props.serviceId,
        ...(props.staffId ? { staffId: props.staffId } : {}),
        date,
        name: name.trim(),
        locale,
      });
      setJoined(date);
    } catch (e) {
      setError(waitlistErrorText(e, t));
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
      {days.length === 0 ? (
        <Text style={styles.muted}>{w.noFullDays}</Text>
      ) : (
        <>
          <TextInput
            accessibilityLabel={t.book.name}
            placeholder={t.book.name}
            value={name}
            onChangeText={setName}
            autoComplete="name"
            style={styles.input}
          />
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
                  accessibilityLabel={`${w.wait}: ${formatDay(date, locale)}`}
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
        </>
      )}
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
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 17,
    color: colors.ink,
  },
  days: { gap: 8, paddingVertical: 2 },
  day: {
    width: 52,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.muted,
    backgroundColor: colors.card,
    alignItems: 'center',
  },
  dayOn: { backgroundColor: colors.ink, borderColor: colors.ink, borderStyle: 'solid' },
  week: { color: colors.muted, fontSize: 12, textTransform: 'capitalize' },
  number: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  onText: { color: '#fff' },
});
