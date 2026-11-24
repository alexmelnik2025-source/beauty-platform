import { useMemo } from 'react';
import { StyleSheet, Text } from 'react-native';
import type { DirectorySalon, Locale } from './api';
import type { Dictionary } from './i18n';
import { openStatus, openStatusText, salonNow } from './salon';
import { colors } from './ui';

/**
 * Tasks 363–364: "Otwarte · do 20:00" / "Zamknięte · otwarcie o 10:00" / "Zamknięte" on a salon
 * card (catalogue, map) — today's real hours of the salon, in its time zone.
 */
export function OpenNow(props: {
  salon: Pick<DirectorySalon, 'timezone' | 'todayHours'>;
  t: Dictionary;
  locale: Locale;
}) {
  const { timezone, todayHours } = props.salon;
  const minute = Math.floor(Date.now() / 60_000);
  const status = useMemo(() => {
    const now = salonNow(minute * 60_000, timezone);
    return openStatus(
      { openingHours: [], todayHours: { date: now.date, intervals: todayHours } },
      now,
    );
  }, [minute, timezone, todayHours]);
  const text = openStatusText(status, props.t.salon, props.locale);
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
}

const styles = StyleSheet.create({
  status: { color: colors.ink, fontSize: 14, fontWeight: '600', flexShrink: 1, maxWidth: '100%' },
});
