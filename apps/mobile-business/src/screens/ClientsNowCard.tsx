import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { BusinessApi } from '../api';
import type { DayLocale } from '../day';
import { fill, type Dictionary } from '../i18n';
import { openStatus, openStatusText, salonNow, todayHoursText, type PublicHours } from '../openNow';
import { colors } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 366, "Klienci widzą teraz": on today's day screen of the owner or a manager — the same
 * "Otwarte · do 20:00" line clients see in the catalogue and on the booking page, with today's
 * hours for clients. Read again with the day (after a block, a special day or time off). Nothing
 * is shown while online booking is off, while loading, or when the reading fails: it is a hint.
 */
export function ClientsNowCard(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: DayLocale;
  salon: SalonChoice;
  reloads: number;
}) {
  const { api, salon, reloads } = props;
  const c = props.t.clientsNow;
  const [hours, setHours] = useState<PublicHours | null>(null);
  // The line follows the clock: it is worked out again every minute.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const location = await api.location(salon.orgId, salon.locationId);
        const next = location.onlineBookingEnabled ? await api.publicHours(location.slug) : null;
        if (alive) {
          setHours(next);
          setNow(Date.now());
        }
      } catch {
        if (alive) setHours(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, salon, reloads]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!hours) return null;
  const status = openStatus(hours, salonNow(now, hours.timezone));
  const line = openStatusText(status, c, props.locale);
  const today = todayHoursText(hours, now);
  return (
    <View style={styles.box} testID="clients-now">
      <Text style={styles.label}>{c.label.toUpperCase()}</Text>
      <Text style={styles.line} accessibilityLabel={`${c.label}: ${line}`}>
        <Text style={{ color: status.kind === 'open' ? '#1f7a45' : colors.muted }}>● </Text>
        {line}
      </Text>
      <Text style={styles.muted}>{today ? fill(c.today, { hours: today }) : c.closedToday}</Text>
      <Text style={styles.hint}>{c.hint}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 4 },
  label: { marginTop: 8, fontSize: 13, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  line: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: 15 },
  hint: { color: colors.muted, fontSize: 13 },
});
