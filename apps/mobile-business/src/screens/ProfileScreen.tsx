import { useEffect, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, StaffList } from '../api';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { flags, languagesChanged, SPOKEN, toggleLanguage, type SpokenLanguage } from '../profile';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 96: "Mój profil" — the signed-in specialist's own profile in this salon: the languages
 * they speak with clients (task 81: the "Mówi po" filter and the flags next to their name).
 * The server lets a specialist change only their own profile.
 */
export function ProfileScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  staffId: string;
  onBack: () => void;
}) {
  const { api, t, salon, staffId, onBack } = props;
  const p = t.profile;
  const [me, setMe] = useState<StaffList[number] | null>(null);
  const [chosen, setChosen] = useState<SpokenLanguage[]>([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .staff(salon.orgId, salon.locationId)
      .then((list) => {
        if (!alive) return;
        const mine = list.find((s) => s.id === staffId) ?? null;
        setMe(mine);
        setChosen(mine?.languages ?? []);
      })
      .catch((e: unknown) => alive && setError(errorText(e, t)));
    return () => {
      alive = false;
    };
  }, [api, salon, staffId, t]);

  // Android "back" goes to the day.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  async function save() {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const saved = await api.setStaffLanguages(salon.orgId, salon.locationId, staffId, chosen);
      setMe(saved);
      setChosen(saved.languages);
      setInfo(p.saved);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.row}>
        <Button kind="link" label={p.back} onPress={onBack} />
      </View>
      <Heading>{p.title}</Heading>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {me ? (
        <>
          <Card>
            <Text style={styles.name}>{me.displayName}</Text>
            <Text style={styles.muted}>
              {salon.locationName}
              {me.languages.length ? ` · ${flags(me.languages)}` : ''}
            </Text>
          </Card>
          <Text style={styles.section}>{p.languages}</Text>
          <Text style={styles.muted}>{p.languagesHint}</Text>
          {SPOKEN.map((l) => {
            const on = chosen.includes(l.code);
            return (
              <Pressable
                key={l.code}
                accessibilityRole="checkbox"
                accessibilityLabel={l.name}
                accessibilityState={{ checked: on }}
                aria-checked={on}
                onPress={() => {
                  setInfo('');
                  setChosen(toggleLanguage(chosen, l.code));
                }}
                style={[styles.option, on && styles.optionOn]}
              >
                <Text style={styles.flag}>{l.flag}</Text>
                <Text style={styles.optionText}>{l.name}</Text>
                <Text style={styles.tick}>{on ? '✓' : ''}</Text>
              </Pressable>
            );
          })}
          {chosen.length === 0 ? <Text style={styles.muted}>{p.none}</Text> : null}
          {info ? <Text style={styles.info}>{info}</Text> : null}
          <Button
            label={p.save}
            busy={busy}
            disabled={!languagesChanged(me.languages, chosen)}
            onPress={() => void save()}
          />
        </>
      ) : !error ? (
        <Text style={styles.muted}>{t.loading}</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 10 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  name: { fontSize: 18, fontWeight: '700', color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
  section: {
    marginTop: 10,
    fontSize: 13,
    fontWeight: '700',
    color: colors.muted,
    letterSpacing: 1,
  },
  info: { color: '#2e7d32', fontSize: 15 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 48,
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 16,
  },
  optionOn: { borderColor: colors.accent, borderWidth: 2 },
  flag: { fontSize: 20 },
  optionText: { fontSize: 16, fontWeight: '600', color: colors.ink, flex: 1 },
  tick: { fontSize: 18, fontWeight: '700', color: colors.ink, width: 20, textAlign: 'center' },
});
