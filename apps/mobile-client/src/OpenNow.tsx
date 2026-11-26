import { useMemo } from 'react';
import { StyleSheet, Text } from 'react-native';
import type { DirectorySalon, Locale } from './api';
import type { Dictionary } from './i18n';
import { openStatus, openStatusText, salonNow } from './salon';
import { colors } from './ui';

// A page of salons often shares one local clock. Only today's hours differ between cards.
const zoneClocks = new Map<string, ReturnType<typeof salonNow>>();
let clockMinute = -1;

function localClock(minute: number, timezone: string) {
  if (clockMinute !== minute) {
    zoneClocks.clear();
    clockMinute = minute;
  }
  const clock = zoneClocks.get(timezone);
  if (clock) return clock;
  const now = salonNow(minute * 60_000, timezone);
  zoneClocks.set(timezone, now);
  return now;
}

/**
 * Tasks 363–364: "Otwarte · do 20:00" / "Zamknięte · otwarcie o 10:00" / "Zamknięte" on a salon
 * card (catalogue, map) — today's real hours of the salon, in its time zone.
 */
export function OpenNow(props: {
  salon: Pick<DirectorySalon, 'timezone' | 'todayHours'>;
  t: Dictionary;
  locale: Locale;
}) {
  const { salon, t, locale } = props;
  const { timezone, todayHours } = salon;
  const minute = Math.floor(Date.now() / 60_000);
  return useMemo(() => {
    const now = localClock(minute, timezone);
    const status = openStatus(
      { openingHours: [], todayHours: { date: now.date, intervals: todayHours } },
      now,
    );
    const text = openStatusText(status, t.salon, locale);
    return (
      <Text
        accessible
        role="status"
        aria-live="polite"
        accessibilityLabel={text}
        style={styles.status}
      >
        <Text aria-hidden style={{ color: status.kind === 'open' ? '#1f7a45' : colors.muted }}>
          ●{' '}
        </Text>
        {text}
      </Text>
    );
  }, [minute, timezone, todayHours, t.salon, locale]);
}

const styles = StyleSheet.create({
  status: { color: colors.ink, fontSize: 14, fontWeight: '600', flexShrink: 1, maxWidth: '100%' },
});
