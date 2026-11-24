import { useEffect, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, StaffList } from '../api';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { flags, languagesChanged, SPOKEN, toggleLanguage, type SpokenLanguage } from '../profile';
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
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
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .staff(salon.orgId, salon.locationId)
      .then((list) => {
        if (!alive) return;
        const mine = list.find((s) => s.id === staffId) ?? null;
        setLoadError('');
        setMe(mine);
        setChosen(mine?.languages ?? []);
      })
      .catch((e: unknown) => alive && setLoadError(errorText(e, t)));
    return () => {
      alive = false;
    };
  }, [api, salon.orgId, salon.locationId, staffId, t]);

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
    setSaveError('');
    setInfo('');
    try {
      const saved = await api.setStaffLanguages(salon.orgId, salon.locationId, staffId, chosen);
      setMe(saved);
      setChosen(saved.languages);
      setInfo(p.saved);
    } catch (e) {
      setSaveError(errorText(e, t));
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
      {loadError ? <ErrorText>{loadError}</ErrorText> : null}
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
          <View
            role="group"
            accessibilityLabel={p.languages}
            aria-invalid={!!saveError}
            aria-describedby={saveError ? 'profile-languages-error' : undefined}
            style={[styles.choices, !!saveError && styles.invalid]}
          >
            {SPOKEN.map((l) => {
              const on = chosen.includes(l.code);
              return (
                <Pressable
                  key={l.code}
                  accessibilityRole="checkbox"
                  accessibilityLabel={l.name}
                  disabled={busy}
                  accessibilityState={{ checked: on, disabled: busy }}
                  aria-checked={on}
                  onPress={() => {
                    setInfo('');
                    setSaveError('');
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
          </View>
          {saveError ? (
            <Text nativeID="profile-languages-error" role="alert" style={styles.fieldError}>
              ! {saveError}
            </Text>
          ) : null}
          {info ? <Text style={styles.info}>{info}</Text> : null}
          <Button
            label={p.save}
            busy={busy}
            disabled={!languagesChanged(me.languages, chosen)}
            onPress={() => void save()}
          />
        </>
      ) : !loadError ? (
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
  choices: { gap: 8 },
  invalid: { borderColor: colors.danger, borderWidth: 1, borderRadius: 12, padding: 4 },
  fieldError: { color: colors.danger, fontSize: 15 },
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
  tick: { fontSize: 18, fontWeight: '700', color: colors.ink, minWidth: 20, textAlign: 'center' },
});
