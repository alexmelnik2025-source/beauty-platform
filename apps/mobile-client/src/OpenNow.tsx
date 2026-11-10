import { Text } from 'react-native';
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
  const now = salonNow(Date.now(), props.salon.timezone);
  const status = openStatus(
    { openingHours: [], todayHours: { date: now.date, intervals: props.salon.todayHours } },
    now,
  );
  const text = openStatusText(status, props.t.salon, props.locale);
  return (
    <Text style={{ color: colors.ink, fontSize: 14, fontWeight: '600' }} accessibilityLabel={text}>
      <Text style={{ color: status.kind === 'open' ? '#1f7a45' : colors.muted }}>● </Text>
      {text}
    </Text>
  );
}
