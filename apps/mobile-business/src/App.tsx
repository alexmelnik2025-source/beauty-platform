import { FormDrafts } from './formDrafts';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { BusinessApi, type Locale } from './api';
import { API_URL } from './config';
import { errorText } from './errors';
import { DICTIONARIES, pickLocale } from './i18n';
import { DayScreen } from './screens/DayScreen';
import { NewSalonScreen, type PendingOrganization } from './screens/NewSalonScreen';
import { SalonsScreen, type SalonChoice } from './screens/SalonsScreen';
import { SignInScreen } from './screens/SignInScreen';
import { tokenStore } from './storage';
import { Button, colors, ErrorText } from './ui';

type Stage =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'signIn' }
  | { kind: 'salons'; choices: SalonChoice[] }
  | { kind: 'newSalon' }
  | { kind: 'day'; choices: SalonChoice[]; salon: SalonChoice; timeZone: string };

const deviceLocale = pickLocale(Intl.DateTimeFormat().resolvedOptions().locale);
const deviceName = `Business app (${Platform.OS})`;

/** Business app: sign-in with a code → choose the salon → the day calendar. */
export default function App() {
  const api = useMemo(() => new BusinessApi(API_URL, tokenStore, undefined, deviceName), []);
  const [locale, setLocale] = useState<Locale>(deviceLocale);
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [pendingOrganization, setPendingOrganization] = useState<PendingOrganization | null>(null);
  const [timeZones, setTimeZones] = useState<Record<string, string>>({});
  const t = DICTIONARIES[locale];

  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  }, [locale]);
  // Read by the loaders below, so that switching the language does not reload the app.
  const localeRef = useRef(locale);
  localeRef.current = locale;

  /** After sign-in: every salon (location) of every organization the person belongs to. */
  const openSalons = useCallback(async () => {
    setStage({ kind: 'loading' });
    try {
      const me = await api.me();
      const choices: SalonChoice[] = [];
      const zones: Record<string, string> = {};
      for (const org of me.organizations) {
        for (const location of await api.locations(org.id)) {
          zones[location.id] = location.timezone;
          choices.push({
            orgId: org.id,
            orgName: org.name,
            role: org.role,
            locationId: location.id,
            locationName: location.name,
            city: location.city,
            currency: location.currency,
          });
        }
      }
      setTimeZones(zones);
      const only = choices.length === 1 ? choices[0] : undefined;
      setStage(
        only
          ? {
              kind: 'day',
              choices,
              salon: only,
              timeZone: zones[only.locationId] ?? 'Europe/Warsaw',
            }
          : { kind: 'salons', choices },
      );
    } catch (e) {
      if (!api.signedIn) setStage({ kind: 'signIn' });
      else setStage({ kind: 'failed', message: errorText(e, DICTIONARIES[localeRef.current]) });
    }
  }, [api]);

  const start = useCallback(async () => {
    setStage({ kind: 'loading' });
    try {
      if (await api.restore()) await openSalons();
      else setStage({ kind: 'signIn' });
    } catch (e) {
      setStage({ kind: 'failed', message: errorText(e, DICTIONARIES[localeRef.current]) });
    }
  }, [api, openSalons]);

  useEffect(() => {
    void start();
  }, [start]);

  const signOut = useCallback(async () => {
    await api.signOut();
    setPendingOrganization(null);
    setStage({ kind: 'signIn' });
  }, [api]);

  function openFreshSalonList() {
    setPendingOrganization(null);
    return openSalons();
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <StatusBar style="dark" />
        <View style={styles.content}>
          {stage.kind === 'loading' ? (
            <ActivityIndicator style={{ marginTop: 80 }} color={colors.ink} />
          ) : stage.kind === 'failed' ? (
            <View style={{ padding: 24, gap: 16 }}>
              <ErrorText>{stage.message}</ErrorText>
              <Button label={t.day.refresh} onPress={start} />
            </View>
          ) : stage.kind === 'signIn' ? (
            <SignInScreen
              api={api}
              t={t}
              locale={locale}
              onLocale={setLocale}
              onSignedIn={openFreshSalonList}
            />
          ) : stage.kind === 'salons' ? (
            <SalonsScreen
              t={t}
              choices={stage.choices}
              onSignOut={signOut}
              onCreate={() => setStage({ kind: 'newSalon' })}
              onChoose={(salon) =>
                setStage({
                  kind: 'day',
                  choices: stage.choices,
                  salon,
                  timeZone: timeZones[salon.locationId] ?? 'Europe/Warsaw',
                })
              }
            />
          ) : stage.kind === 'newSalon' ? (
            <NewSalonScreen
              api={api}
              t={t}
              locale={locale}
              organization={pendingOrganization}
              onOrganizationCreated={setPendingOrganization}
              onCreated={openFreshSalonList}
              onBack={openSalons}
            />
          ) : (
            <FormDrafts key={stage.salon.locationId}>
              <DayScreen
                api={api}
                t={t}
                locale={locale}
                salon={stage.salon}
                timeZone={stage.timeZone}
                canChangeSalon={stage.choices.length > 1}
                onChangeSalon={() => setStage({ kind: 'salons', choices: stage.choices })}
                onSignOut={signOut}
                onLocale={setLocale}
              />
            </FormDrafts>
          )}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, width: '100%', maxWidth: 640, alignSelf: 'center' },
});
