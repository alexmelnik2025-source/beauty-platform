import { useEffect, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, Locale, StaffList } from '../api';
import { errorText } from '../errors';
import { teamForHours } from '../hours';
import type { Dictionary } from '../i18n';
import { Button, colors, ErrorText, Heading } from '../ui';
import { ScheduleScreen } from './ScheduleScreen';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 95: "Grafik zespołu" — owner or manager: the salon's specialists → one of them →
 * their weekly hours and time off (changed in ScheduleScreen; the server checks the rights).
 */
export function TeamHoursScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  today: string;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const s = t.schedule;
  const [team, setTeam] = useState<StaffList | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .staff(salon.orgId, salon.locationId)
      .then((list) => alive && setTeam(teamForHours(list)))
      .catch((e: unknown) => alive && setError(errorText(e, t)));
    return () => {
      alive = false;
    };
  }, [api, salon, t]);

  // Android "back" goes to the day, unless a specialist's schedule is open (it handles it).
  useEffect(() => {
    if (open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack, open]);

  if (open) {
    return (
      <ScheduleScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        staffId={open.id}
        staffName={open.name}
        today={props.today}
        onBack={() => setOpen(null)}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.row}>
        <Button kind="link" label={s.back} onPress={onBack} />
      </View>
      <Heading>{s.teamTitle}</Heading>
      <Text style={styles.muted}>{s.teamHint}</Text>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {!team ? (
        !error ? (
          <Text style={styles.muted}>{t.loading}</Text>
        ) : null
      ) : team.length === 0 ? (
        <Text style={styles.muted}>{s.noStaff}</Text>
      ) : (
        team.map((member) => (
          <Pressable
            key={member.id}
            accessibilityRole="button"
            accessibilityLabel={member.displayName}
            onPress={() => setOpen({ id: member.id, name: member.displayName })}
            style={({ pressed }) => [styles.option, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.name}>{member.displayName}</Text>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 10 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  muted: { color: colors.muted, fontSize: 15 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  name: { fontSize: 16, fontWeight: '600', color: colors.ink },
  chevron: { fontSize: 20, color: colors.muted },
});
