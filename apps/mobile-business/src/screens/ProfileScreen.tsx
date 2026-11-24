import { useEffect, useRef, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, type BusinessApi, type StaffList } from '../api';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { flags, languagesChanged, SPOKEN, toggleLanguage, type SpokenLanguage } from '../profile';
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
import { SalonReadCache } from './HistoryScreen';
import type { SalonChoice } from './SalonsScreen';

const profiles = new SalonReadCache<StaffList[number]>();

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
  const [loadError, setLoadError] = useState<{ cause: unknown } | null>(null);
  const [saveError, setSaveError] = useState('');
  const [info, setInfo] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    let loadingHere = false;
    profiles
      .read(
        salon,
        async () => {
          loadingHere = true;
          try {
            const staff = await api.staff(salon.orgId, salon.locationId);
            const mine = staff.find((member) => member.id === staffId);
            if (!mine) throw new ApiError(404, 'Profile not found');
            return mine;
          } finally {
            loadingHere = false;
          }
        },
        staffId,
      )
      .then((mine) => {
        if (!active) return;
        setMe(mine);
        setChosen(mine.languages);
      })
      .catch((cause: unknown) => active && setLoadError({ cause }));
    return () => {
      active = false;
      // A fresh visit starts its own read if the previous screen left mid-request.
      if (loadingHere) profiles.clear(salon);
    };
  }, [api, salon, staffId, loadAttempt]);

  // Android "back" goes to the day.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  async function save() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setSaveError('');
    setInfo('');
    try {
      // A profile reopened during the write waits for the server's saved version.
      profiles.clear(salon);
      const saved = await profiles.read(
        salon,
        () => api.setStaffLanguages(salon.orgId, salon.locationId, staffId, chosen),
        staffId,
      );
      setMe(saved);
      setChosen(saved.languages);
      setInfo(p.saved);
    } catch (e) {
      setSaveError(errorText(e, t));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.row}>
        <Button kind="link" label={p.back} onPress={onBack} />
      </View>
      <Heading>{p.title}</Heading>
      {loadError ? (
        <>
          <ErrorText>{errorText(loadError.cause, t)}</ErrorText>
          <Button
            label={t.day.refresh}
            onPress={() => {
              setLoadError(null);
              setLoadAttempt((attempt) => attempt + 1);
            }}
          />
        </>
      ) : null}
      {me ? (
        <>
          <Card>
            <Text style={styles.name}>{me.displayName}</Text>
            <Text style={styles.muted}>
              {salon.locationName}
              {me.languages.length ? ` · ${flags(me.languages)}` : ''}
            </Text>
          </Card>
          <Text nativeID="profile-languages-label" style={styles.section}>
            {p.languages}
          </Text>
          <Text nativeID="profile-languages-hint" style={styles.muted}>
            {p.languagesHint}
          </Text>
          <View
            role="group"
            accessibilityLabel={p.languages}
            aria-labelledby="profile-languages-label"
            aria-invalid={!!saveError}
            aria-describedby={saveError ? 'profile-languages-error' : 'profile-languages-hint'}
            style={[styles.choices, !!saveError && styles.invalid]}
          >
            {SPOKEN.map((l) => {
              const on = chosen.includes(l.code);
              return (
                <Pressable
                  key={l.code}
                  accessibilityRole="checkbox"
                  accessibilityLabel={l.name}
                  accessibilityHint={saveError || undefined}
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
            <Text
              nativeID="profile-languages-error"
              role="alert"
              accessibilityLiveRegion="assertive"
              style={styles.fieldError}
            >
              ! {saveError}
            </Text>
          ) : null}
          {info ? (
            <Text role="status" accessibilityLiveRegion="polite" style={styles.info}>
              {info}
            </Text>
          ) : null}
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
