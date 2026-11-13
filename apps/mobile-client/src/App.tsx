import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ClientApi, type ClientPerson, type Locale, type PublicLocation } from './api';
import type { BookingPreset } from './booking';
import { API_URL } from './config';
import { errorText } from './errors';
import { appLocale, DICTIONARIES, pickLocale } from './i18n';
import { BookingScreen } from './screens/BookingScreen';
import { CatalogScreen } from './screens/CatalogScreen';
import { OpenBooking } from './screens/OpenBooking';
import { SalonScreen } from './screens/SalonScreen';
import { SignInScreen } from './screens/SignInScreen';
import { VisitsScreen } from './screens/VisitsScreen';
import { rememberViewed, type RecentSalon } from './recent';
import { recentSalonsStore, tokenStore } from './storage';
import { Button, colors, ErrorText } from './ui';

type Stage =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'signIn' }
  | { kind: 'visits'; person: ClientPerson };

/**
 * The catalogue, a salon and its booking, opened over sign-in or "My visits" (no sign-in
 * needed). "Book again" and "Book" on a loyalty card open the booking straight from "My visits"
 * (`fromVisits`: back returns there) with the same service and specialist.
 */
type Finder =
  | null
  | { kind: 'catalog'; query?: string; openNow?: boolean; bestRated?: boolean }
  | { kind: 'salon'; slug: string; name: string; fromVisits?: boolean }
  | { kind: 'open'; slug: string; name: string; preset?: BookingPreset }
  | { kind: 'book'; salon: PublicLocation; preset?: BookingPreset; fromVisits?: boolean };

const deviceLocale = pickLocale(Intl.DateTimeFormat().resolvedOptions().locale);

/**
 * Client app: sign-in with an emailed code → my visits in every salon; the catalogue of
 * salons and a salon's page, with or without signing in.
 */
export default function App() {
  const api = useMemo(() => new ClientApi(API_URL, tokenStore), []);
  const [locale, setLocale] = useState<Locale>(deviceLocale);
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [finder, setFinder] = useState<Finder>(null);
  // A new key reloads "My visits" (after booking) or prefills the sign-in email.
  const [visitsKey, setVisitsKey] = useState(0);
  const [signInEmail, setSignInEmail] = useState('');
  // Grows when a salon is saved to or removed from "Favourites" on its page.
  const [favoritesVersion, setFavoritesVersion] = useState(0);
  const favoriteChanged = useCallback(() => setFavoritesVersion((v) => v + 1), []);
  const openSalonFromVisits = useCallback(
    (slug: string, name: string) => setFinder({ kind: 'salon', slug, name, fromVisits: true }),
    [],
  );
  // Task 180b: "Czego szukasz?" on the start screen opens the catalogue with that search.
  const openCatalog = useCallback(
    (query?: string) => setFinder({ kind: 'catalog', ...(query && { query }) }),
    [],
  );
  // Task 370: "Otwarte teraz (n)" on the start screen — the catalogue with the filter on.
  const openCatalogOpenNow = useCallback(() => setFinder({ kind: 'catalog', openNow: true }), []);
  // Task 379: "★ Najlepiej oceniane" on the start screen — the best rated salons first.
  const openCatalogBestRated = useCallback(
    () => setFinder({ kind: 'catalog', bestRated: true }),
    [],
  );
  const openBooking = useCallback(
    (slug: string, name: string, preset?: BookingPreset) =>
      setFinder({ kind: 'open', slug, name, ...(preset && { preset }) }),
    [],
  );
  // Task 402: "Ostatnio oglądane" on the start screen — kept on this device only.
  const [recent, setRecent] = useState<RecentSalon[]>([]);
  useEffect(() => {
    void recentSalonsStore.get().then(setRecent);
  }, []);
  const salonViewed = useCallback((salon: RecentSalon) => {
    setRecent((list) => {
      const next = rememberViewed(list, salon);
      void recentSalonsStore.set(next);
      return next;
    });
  }, []);
  const openRecent = useCallback(
    (salon: RecentSalon) => setFinder({ kind: 'salon', slug: salon.slug, name: salon.name }),
    [],
  );
  const t = DICTIONARIES[locale];
  const localeRef = useRef(locale);
  localeRef.current = locale;

  const signedIn = useCallback((person: ClientPerson) => {
    // The language the client chose last time (it is also the language of the salons' emails).
    setLocale(appLocale(person.locale));
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
          {/* Sign-in / "My visits" and the catalogue stay mounted: going back keeps what was typed. */}
          <View style={finder ? styles.hidden : styles.fill}>
            {stage.kind === 'loading' ? (
              <ActivityIndicator style={{ marginTop: 80 }} color={colors.ink} />
            ) : stage.kind === 'failed' ? (
              <View style={{ padding: 24, gap: 16 }}>
                <ErrorText>{stage.message}</ErrorText>
                <Button label={t.visits.refresh} onPress={start} />
              </View>
            ) : stage.kind === 'signIn' ? (
              <SignInScreen
                key={signInEmail}
                initialEmail={signInEmail}
                api={api}
                t={t}
                locale={locale}
                onLocale={changeLocale}
                onSignedIn={signedIn}
                onFindSalon={openCatalog}
                onOpenNow={openCatalogOpenNow}
                onBestRated={openCatalogBestRated}
                recent={recent}
                onOpenRecent={openRecent}
              />
            ) : (
              <VisitsScreen
                key={visitsKey}
                api={api}
                t={t}
                locale={locale}
                person={stage.person}
                onLocale={changeLocale}
                onSignOut={signOut}
                onSessionEnded={sessionEnded}
                onFindSalon={openCatalog}
                onBook={openBooking}
                onOpenSalon={openSalonFromVisits}
                favoritesVersion={favoritesVersion}
              />
            )}
          </View>
          {finder ? (
            <View style={finder.kind === 'catalog' ? styles.fill : styles.hidden}>
              <CatalogScreen
                api={api}
                t={t}
                locale={locale}
                onLocale={changeLocale}
                initialQuery={finder.kind === 'catalog' ? finder.query : undefined}
                initialOpenNow={finder.kind === 'catalog' && finder.openNow === true}
                initialBestRated={finder.kind === 'catalog' && finder.bestRated === true}
                onOpen={(s) => setFinder({ kind: 'salon', slug: s.slug, name: s.name })}
                onBack={() => setFinder(null)}
              />
            </View>
          ) : null}
          {finder?.kind === 'open' ? (
            <OpenBooking
              key={finder.slug}
              api={api}
              t={t}
              slug={finder.slug}
              name={finder.name}
              onBack={() => setFinder(null)}
              onLoaded={(salon) =>
                setFinder((f) =>
                  f?.kind === 'open'
                    ? { kind: 'book', salon, preset: f.preset, fromVisits: true }
                    : f,
                )
              }
            />
          ) : null}
          {finder?.kind === 'book' ? (
            <BookingScreen
              key={finder.salon.slug}
              api={api}
              t={t}
              locale={locale}
              salon={finder.salon}
              email={stage.kind === 'visits' ? stage.person.email : undefined}
              signedIn={stage.kind === 'visits'}
              preset={finder.preset}
              onBack={() =>
                finder.fromVisits
                  ? setFinder(null)
                  : setFinder({ kind: 'salon', slug: finder.salon.slug, name: finder.salon.name })
              }
              onFinished={(email) => {
                setFinder(null);
                if (stage.kind === 'visits') setVisitsKey((k) => k + 1);
                else setSignInEmail(email);
              }}
            />
          ) : null}
          {finder?.kind === 'salon' ? (
            <SalonScreen
              key={finder.slug}
              api={api}
              t={t}
              locale={locale}
              slug={finder.slug}
              name={finder.name}
              onBack={() => setFinder(finder.fromVisits ? null : { kind: 'catalog' })}
              onBook={(salon) => setFinder({ kind: 'book', salon })}
              signedIn={stage.kind === 'visits'}
              onFavoriteChanged={favoriteChanged}
              onViewed={salonViewed}
              onOpenSalon={(s) =>
                setFinder({
                  kind: 'salon',
                  slug: s.slug,
                  name: s.name,
                  fromVisits: finder.fromVisits,
                })
              }
            />
          ) : null}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, width: '100%', maxWidth: 640, alignSelf: 'center' },
  fill: { flex: 1 },
  hidden: { display: 'none' },
});
