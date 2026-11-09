import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { BusinessApi } from '../api';
import type { Dictionary } from '../i18n';
import { bookableStaff, hasWeeklyHours, setupFinished, setupState, type SetupStep } from '../setup';
import { Button, Card, colors } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 352, "Pierwsze kroki": a card on the day screen of the owner or a manager while the salon
 * is not ready for online booking. Every open step has a button to its screen; the card is read
 * again each time the day screen comes back and disappears once all steps are done. Nothing is
 * shown while loading or when the reading fails — the card is a hint, not a blocker.
 */
export function SetupCard(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  onOpen: (step: SetupStep) => void;
}) {
  const { api, salon, t } = props;
  const s = t.setup;
  const [steps, setSteps] = useState<{ step: SetupStep; done: boolean }[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
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
        if (alive) setSteps(setupState({ location, services, staff, hoursSet }));
      } catch {
        if (alive) setSteps(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, salon]);

  if (!steps || setupFinished(steps)) return null;
  const left = steps.filter((x) => !x.done).length;
  return (
    <Card>
      <Text style={styles.title} role="heading">
        {s.title}
      </Text>
      <Text style={styles.muted}>{s.lead.replace('{n}', String(left))}</Text>
      {steps.map(({ step, done }, i) => (
        <View key={step} style={styles.step}>
          <Text
            style={[styles.text, done && styles.done]}
            accessibilityLabel={`${i + 1}. ${s.steps[step]} — ${done ? s.doneLabel : s.todoLabel}`}
          >
            {done ? '✓' : `${i + 1}.`} {s.steps[step]}
          </Text>
          {!done ? (
            <Button
              kind="link"
              label={s.go}
              a11yLabel={`${s.go}: ${s.steps[step]}`}
              onPress={() => props.onOpen(step)}
            />
          ) : null}
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 17, fontWeight: '700', color: colors.ink },
  muted: { color: colors.muted, fontSize: 14, marginBottom: 6 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 36 },
  text: { flex: 1, fontSize: 15, color: colors.ink },
  done: { color: colors.muted, textDecorationLine: 'line-through' },
});
