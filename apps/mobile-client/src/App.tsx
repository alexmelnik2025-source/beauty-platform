import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ClientApi, type ClientPerson, type Locale } from './api';
import { API_URL } from './config';
import { errorText } from './errors';
import { DICTIONARIES, pickLocale } from './i18n';
import { SignInScreen } from './screens/SignInScreen';
import { VisitsScreen } from './screens/VisitsScreen';
import { tokenStore } from './storage';
import { Button, colors, ErrorText } from './ui';

type Stage =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'signIn' }
  | { kind: 'visits'; person: ClientPerson };

const deviceLocale = pickLocale(Intl.DateTimeFormat().resolvedOptions().locale);

/** Client app: sign-in with an emailed code → my visits in every salon. */
export default function App() {
  const api = useMemo(() => new ClientApi(API_URL, tokenStore), []);
  const [locale, setLocale] = useState<Locale>(deviceLocale);
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const t = DICTIONARIES[locale];
  const localeRef = useRef(locale);
  localeRef.current = locale;

  const signedIn = useCallback((person: ClientPerson) => {
    // The language the client chose last time (it is also the language of the salons' emails).
    setLocale(person.locale);
    setStage({ kind: 'visits', person });
  }, []);

  const start = useCallback(async () => {
    setStage({ kind: 'loading' });
    try {
      const person = await api.restore();
      if (person) signedIn(person);
      else setStage({ kind: 'signIn' });
    } catch (e) {
      setStage({ kind: 'failed', message: errorText(e, DICTIONARIES[localeRef.current]) });
    }
  }, [api, signedIn]);

  useEffect(() => {
    void start();
  }, [start]);

  const signOut = useCallback(async () => {
    await api.signOut();
    setStage({ kind: 'signIn' });
  }, [api]);

  const sessionEnded = useCallback(() => setStage({ kind: 'signIn' }), []);

  const changeLocale = useCallback(
    (next: Locale) => {
      setLocale(next);
      if (api.signedIn) {
        api.setLocale(next).catch(() => {
          // Only the emails stay in the old language; the app has already switched.
        });
      }
    },
    [api],
  );

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
              <Button label={t.visits.refresh} onPress={start} />
            </View>
          ) : stage.kind === 'signIn' ? (
            <SignInScreen
              api={api}
              t={t}
              locale={locale}
              onLocale={changeLocale}
              onSignedIn={signedIn}
            />
          ) : (
            <VisitsScreen
              api={api}
              t={t}
              locale={locale}
              person={stage.person}
              onLocale={changeLocale}
              onSignOut={signOut}
              onSessionEnded={sessionEnded}
            />
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
