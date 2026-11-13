import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { BusinessApi, Locale, StaffList } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { movedOrder, nextSortOrder, teamForProfiles } from '../staffProfile';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import { ScheduleScreen } from './ScheduleScreen';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 95: "Grafik zespołu" — owner or manager: the salon's specialists → one of them →
 * their profile (task 326–327), weekly hours and time off (ScheduleScreen; the server checks the
 * rights). Task 326: specialists who do not take clients stay on the list (marked), so they can
 * be switched back on. Task 328: "+ Dodaj specjalistę" — a profile without an account. Task 329:
 * arrows put the specialists in the order clients see them.
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
  const p = t.staffProfile;
  const [team, setTeam] = useState<StaffList | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ id: string; name: string; notice?: string } | null>(null);
  /** Task 328: the name typed for a new specialist (null = the form is closed). */
  const [newName, setNewName] = useState<string | null>(null);

  /** Task 372: only the latest read is shown — an older answer arriving later is dropped. */
  const reads = useRef(0);
  const load = useCallback(async () => {
    const n = ++reads.current;
    try {
      const staff = await api.staff(salon.orgId, salon.locationId);
      if (n === reads.current) setTeam(teamForProfiles(staff));
    } catch (e) {
      if (n === reads.current) setError(errorText(e, t));
    }
  }, [api, salon, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Android "back" goes to the day, unless a specialist's schedule is open (it handles it).
  useEffect(() => {
    if (open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack, open]);

  async function move(id: string, delta: -1 | 1) {
    if (!team || busy) return;
    const order = movedOrder(team, id, delta);
    if (!order) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const saved = await api.reorderStaff(salon.orgId, salon.locationId, order);
      reads.current++; // a list read started before the move is older than this one
      setTeam(teamForProfiles(saved));
      setInfo(p.orderSaved);
    } catch (e) {
      setError(errorText(e, t));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!team || newName === null || busy) return;
    const displayName = newName.trim();
    setError('');
    setInfo('');
    if (!displayName) {
      setError(p.noName);
      return;
    }
    setBusy(true);
    try {
      const services = await api.services(salon.orgId, salon.locationId);
      const created = await api.createStaff(salon.orgId, salon.locationId, {
        displayName,
        sortOrder: nextSortOrder(team),
        serviceIds: services.filter((x) => x.active).map((x) => x.id),
      });
      setNewName(null);
      // Straight to their page: the working hours come next.
      setOpen({ id: created.id, name: created.displayName, notice: p.created });
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  if (open) {
    return (
      <ScheduleScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        staffId={open.id}
        staffName={open.name}
        notice={open.notice}
        onRenamed={(name) => setOpen({ ...open, name })}
        // Task 372: "‹ Wróć" pressed while the profile was still saving must not leave the old list.
        onSaved={() => void load()}
        today={props.today}
        onBack={() => {
          setOpen(null);
          setInfo('');
          void load();
        }}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={s.back} onPress={onBack} />
      </View>
      <Heading>{s.teamTitle}</Heading>
      <Text style={styles.muted}>{s.teamHint}</Text>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {info ? <Text style={styles.info}>{info}</Text> : null}
      {!team ? (
        !error ? (
          <Text style={styles.muted}>{t.loading}</Text>
        ) : null
      ) : team.length === 0 ? (
        <Text style={styles.muted}>{s.noStaff}</Text>
      ) : (
        <>
          {team.map((member, i) => (
            <View key={member.id} style={styles.line}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={member.displayName}
                onPress={() => setOpen({ id: member.id, name: member.displayName })}
                style={({ pressed }) => [styles.option, pressed && { opacity: 0.7 }]}
              >
                <View style={{ flexShrink: 1 }}>
                  <Text style={[styles.name, !member.active && { color: colors.muted }]}>
                    {member.displayName}
                  </Text>
                  {!member.active ? <Text style={styles.small}>{p.inactive}</Text> : null}
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
              {team.length > 1 ? (
                <View style={styles.arrows}>
                  <Button
                    kind="secondary"
                    label="↑"
                    a11yLabel={fill(p.up, { name: member.displayName })}
                    disabled={i === 0 || busy}
                    onPress={() => void move(member.id, -1)}
                  />
                  <Button
                    kind="secondary"
                    label="↓"
                    a11yLabel={fill(p.down, { name: member.displayName })}
                    disabled={i === team.length - 1 || busy}
                    onPress={() => void move(member.id, 1)}
                  />
                </View>
              ) : null}
            </View>
          ))}
          {team.length > 1 ? <Text style={styles.small}>{p.orderHint}</Text> : null}
        </>
      )}
      {team && newName === null ? (
        <Button
          kind="secondary"
          label={p.add}
          onPress={() => {
            setInfo('');
            setError('');
            setNewName('');
          }}
        />
      ) : null}
      {team && newName !== null ? (
        <Card>
          <Text style={styles.label}>{p.newName}</Text>
          <TextInput
            accessibilityLabel={p.newName}
            value={newName}
            maxLength={80}
            autoFocus
            onChangeText={setNewName}
            style={styles.input}
          />
          <Text style={styles.small}>{p.newHint}</Text>
          <View style={styles.row}>
            <Button label={p.create} busy={busy} onPress={() => void create()} />
            <Button kind="link" label={p.cancel} onPress={() => setNewName(null)} />
          </View>
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 10 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  line: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  arrows: { flexDirection: 'row', gap: 4 },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  info: { color: colors.ink, fontSize: 15 },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    letterSpacing: 1,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    backgroundColor: colors.card,
    color: colors.ink,
    marginBottom: 6,
  },
  option: {
    flex: 1,
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
