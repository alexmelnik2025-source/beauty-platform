import { useEffect, useId, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { bookableStaff, hasWeeklyHours, setupFinished, setupState, type SetupStep } from '../setup';
import { Button, Card, colors, ErrorText } from '../ui';
import { SalonReadCache } from './HistoryScreen';
import type { SalonChoice } from './SalonsScreen';

const setupCache = new SalonReadCache<ReturnType<typeof setupState>>();

export function SetupCard(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  onOpen: (step: SetupStep) => void;
}) {
  const { api, salon, t } = props;
  const s = t.setup;
  const [steps, setSteps] = useState<ReturnType<typeof setupState> | null>(null);
  const [error, setError] = useState('');
  const summaryId = useId();
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    setSteps(null);
    setError('');
    setExpanded(false);
    setupCache
      .read(salon, async () => {
        const [location, services, staff] = await Promise.all([
          api.location(salon.orgId, salon.locationId),
          api.services(salon.orgId, salon.locationId),
          api.staff(salon.orgId, salon.locationId),
        ]);
        let hoursSet = false;
        for (const person of bookableStaff(services, staff)) {
          const hours = await api.workingHours(salon.orgId, salon.locationId, person.id);
          if (hasWeeklyHours(hours)) {
            hoursSet = true;
            break;
          }
        }
        return setupState({ location, services, staff, hoursSet });
      })
      .then(
        (next) => {
          if (alive) setSteps(next);
        },
        (e: unknown) => {
          if (alive) setError(errorText(e, t));
        },
      );
    return () => {
      alive = false;
    };
  }, [api, salon, t, attempt]);

  if (steps && setupFinished(steps)) return null;
  const lead = steps ? fill(s.lead, { n: String(steps.filter((step) => !step.done).length) }) : '';
  return (
    <View role="group" accessibilityLabel={s.title} accessible={false}>
      <Card>
        <Text
          style={styles.title}
          role="heading"
          aria-level={2}
          aria-describedby={lead ? summaryId : undefined}
          accessibilityLabel={Platform.OS !== 'web' && lead ? `${s.title}: ${lead}` : undefined}
        >
          {s.title}
        </Text>
        {error ? (
          <>
            <ErrorText>{error}</ErrorText>
            <Button
              kind="secondary"
              label={t.day.refresh}
              a11yLabel={`${t.day.refresh}: ${s.title}`}
              onPress={() => setAttempt((n) => n + 1)}
            />
          </>
        ) : !steps ? (
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={`${s.title}: ${t.loading}`}
            style={styles.skeleton}
          />
        ) : (
          <>
            <Text nativeID={summaryId} aria-hidden style={styles.muted}>
              {lead}
            </Text>
            <Button
              kind="secondary"
              label={`${t.navigation.more} ${expanded ? '▴' : '▸'}`}
              a11yLabel={`${t.navigation.more}: ${s.title}`}
              expanded={expanded}
              onPress={() => setExpanded(!expanded)}
            />
            {expanded &&
              steps.map(({ step, done }, i) =>
                done ? (
                  <Text
                    key={step}
                    accessible
                    role="checkbox"
                    aria-checked
                    aria-disabled
                    style={styles.muted}
                    accessibilityLabel={`${i + 1}. ${s.steps[step]} — ${s.doneLabel}`}
                  >
                    ✓ {s.steps[step]}
                  </Text>
                ) : (
                  <Button
                    key={step}
                    kind="secondary"
                    label={s.steps[step]}
                    a11yLabel={`${s.go}: ${s.steps[step]} — ${s.todoLabel}`}
                    onPress={() => {
                      setupCache.clear(salon);
                      props.onOpen(step);
                    }}
                  />
                ),
              )}
          </>
        )}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 17, fontWeight: '700', color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
  skeleton: { height: 16, width: '75%', borderRadius: 4, backgroundColor: colors.soft },
});
