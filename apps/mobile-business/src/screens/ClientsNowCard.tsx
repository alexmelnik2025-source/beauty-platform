import { useEffect, useId, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi } from '../api';
import type { DayLocale } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { openStatus, openStatusText, salonNow, todayHoursText, type PublicHours } from '../openNow';
import { Button, Card, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

export function ClientsNowCard(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: DayLocale;
  salon: SalonChoice;
  reloads: number;
}) {
  const { api, salon, reloads, t, locale } = props;
  const c = t.clientsNow;
  // undefined while reading, null when online booking is switched off.
  const [hours, setHours] = useState<PublicHours | null>();
  const [error, setError] = useState('');
  const summaryId = useId();
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    setError('');
    setHours(undefined);
    void (async () => {
      try {
        const location = await api.location(salon.orgId, salon.locationId);
        if (!alive) return;
        const next = location.onlineBookingEnabled ? await api.publicHours(location.slug) : null;
        if (alive) {
          setHours(next);
          setNow(Date.now());
        }
      } catch (e) {
        if (alive) setError(errorText(e, t));
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, salon, reloads, attempt, t]);

  useEffect(() => {
    if (!hours) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [hours]);

  const line = hours
    ? openStatusText(openStatus(hours, salonNow(now, hours.timezone)), c, locale)
    : hours === null
      ? t.salon.onlineOff
      : '';
  const today = hours && expanded ? todayHoursText(hours, now) : '';
  return (
    <View testID="clients-now" role="group" accessibilityLabel={c.label} accessible={false}>
      <Card>
        <Text
          style={styles.title}
          role="heading"
          aria-level={2}
          aria-describedby={line ? summaryId : undefined}
          accessibilityLabel={Platform.OS !== 'web' && line ? `${c.label}: ${line}` : undefined}
        >
          {c.label}
        </Text>
        {error ? (
          <>
            <ErrorText>{error}</ErrorText>
            <Button
              kind="secondary"
              label={t.day.refresh}
              a11yLabel={`${t.day.refresh}: ${c.label}`}
              onPress={() => setAttempt((n) => n + 1)}
            />
          </>
        ) : hours === undefined ? (
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={`${c.label}: ${t.loading}`}
            style={styles.skeleton}
          />
        ) : (
          <>
            <Text
              aria-hidden
              style={hours ? styles.line : styles.muted}
              accessibilityLabel={`${c.label}: ${line}`}
            >
              <Text nativeID={summaryId}>{line}</Text>
            </Text>
            {hours && (
              <>
                <Button
                  kind="secondary"
                  label={`${t.navigation.more} ${expanded ? '▴' : '▸'}`}
                  a11yLabel={`${t.navigation.more}: ${c.label}`}
                  expanded={expanded}
                  onPress={() => setExpanded(!expanded)}
                />
                {expanded && (
                  <>
                    <Text style={styles.muted}>
                      {today ? fill(c.today, { hours: today }) : c.closedToday}
                    </Text>
                    <Text style={styles.muted}>{c.hint}</Text>
                  </>
                )}
              </>
            )}
          </>
        )}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 17, fontWeight: '700', color: colors.ink },
  line: { fontSize: 16, color: colors.ink },
  muted: { fontSize: 15, color: colors.muted },
  skeleton: { height: 16, width: '75%', borderRadius: 4, backgroundColor: colors.soft },
});
