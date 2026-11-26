import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ClientApi, type ClientPerson, type Locale, type PublicLocation } from './api';
import type { BookingPreset } from './booking';
import { API_URL } from './config';
import { parseDeepLink } from './deepLink';
import { errorText } from './errors';
import { appLocale, DICTIONARIES, pickLocale } from './i18n';
import { BookingScreen } from './screens/BookingScreen';
import { CatalogScreen } from './screens/CatalogScreen';
import { OpenBooking } from './screens/OpenBooking';
import { SalonScreen } from './screens/SalonScreen';
import { ShopScreen } from './screens/ShopScreen';
import { SignInScreen } from './screens/SignInScreen';
import { VisitsScreen } from './screens/VisitsScreen';
import { rememberViewed, type RecentSalon } from './recent';
import { recentSalonsStore, tokenStore } from './storage';
import { Button, colors, ErrorText, LoadingCards } from './ui';

type Stage =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'signIn' }
  | { kind: 'visits'; person: ClientPerson };

/** Screens opened over sign-in or "My visits". Back reveals the preceding screen. */
type Finder =
  | { kind: 'catalog'; query?: string; openNow?: boolean; bestRated?: boolean }
  | { kind: 'shop' }
  | { kind: 'salon'; slug: string; name: string }
  | { kind: 'open'; slug: string; name: string; preset?: BookingPreset }
  | { kind: 'book'; salon: PublicLocation; preset?: BookingPreset };

const deviceLocale = pickLocale(Intl.DateTimeFormat().resolvedOptions().locale);

/**
 * Client app: sign-in with an emailed code → my visits in every salon; the catalogue of
 * salons and a salon's page, with or without signing in.
 */
export default function App() {
  const api = useMemo(() => new ClientApi(API_URL, tokenStore), []);
  const [locale, setLocale] = useState<Locale>(deviceLocale);
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [finderPath, setFinderPath] = useState<Finder[]>([]);
  const finder = finderPath.at(-1);
  const catalog = finderPath.find((screen) => screen.kind === 'catalog');
  const back = () => setFinderPath(finderPath.slice(0, -1));
  const openSalon = ({ slug, name }: { slug: string; name: string }) =>
    setFinderPath([...finderPath, { kind: 'salon', slug, name }]);
  // A new key reloads "My visits" (after booking) or prefills the sign-in email.
  const [visitsKey, setVisitsKey] = useState(0);
  const [signInEmail, setSignInEmail] = useState('');
  // Grows when a salon is saved to or removed from "Favourites" on its page.
  const [favoritesVersion, setFavoritesVersion] = useState(0);
  const favoriteChanged = useCallback(() => setFavoritesVersion((v) => v + 1), []);
  const openSalonFromHome = useCallback(
    (slug: string, name: string) => setFinderPath([{ kind: 'salon', slug, name }]),
    [],
  );
  // Task 180b: "Czego szukasz?" on the start screen opens the catalogue with that search.
  const openCatalog = useCallback(
    (query?: string) => setFinderPath([{ kind: 'catalog', query }]),
    [],
  );
  // Task 370: "Otwarte teraz (n)" on the start screen — the catalogue with the filter on.
  const openCatalogOpenNow = useCallback(
    () => setFinderPath([{ kind: 'catalog', openNow: true }]),
    [],
  );
  // Task 379: "★ Najlepiej oceniane" on the start screen — the best rated salons first.
  const openCatalogBestRated = useCallback(
    () => setFinderPath([{ kind: 'catalog', bestRated: true }]),
    [],
  );
  // Task Q3: "Sklep" — products from salons, under "Znajdź salon" on the start screen.
  const openShop = useCallback(() => setFinderPath([{ kind: 'shop' }]), []);
  const openBooking = useCallback(
    (slug: string, name: string, preset?: BookingPreset) =>
      setFinderPath([{ kind: 'open', slug, name, preset }]),
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
  const clearRecent = useCallback(() => {
    setRecent([]);
    void recentSalonsStore.set([]);
  }, []);
  const openRecent = useCallback(
    (salon: RecentSalon) => openSalonFromHome(salon.slug, salon.name),
    [openSalonFromHome],
  );
  const t = DICTIONARIES[locale];

  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  }, [locale]);
  const localeRef = useRef(locale);
  localeRef.current = locale;

  // Task Q2: a link opens the app at a salon — "Install the app" on the salon's booking page,
  // the Android intent link, a QR code or a shared link — with the booking started at the
  // same service and specialist when the link names them.
  const openLink = useCallback((url: string | null | undefined) => {
    const link = parseDeepLink(url);
    if (!link) return;
    setFinderPath(
      link.preset
        ? [{ kind: 'open', slug: link.slug, name: '', preset: link.preset }]
        : [{ kind: 'catalog' }, { kind: 'salon', slug: link.slug, name: '' }],
    );
  }, []);
  useEffect(() => {
    void Linking.getInitialURL()
      .then(openLink)
      .catch(() => undefined);
    const subscription = Linking.addEventListener('url', ({ url }) => openLink(url));
    return () => subscription.remove();
  }, [openLink]);

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
      if (api.signedIn) return api.setLocale(next).then(() => undefined);
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
              <View style={{ padding: 20 }}>
                <LoadingCards label={t.loading} />
              </View>
            ) : stage.kind === 'failed' ? (
              <View style={{ padding: 24, gap: 16 }}>
                <ErrorText>{stage.message}</ErrorText>
                <Button label={t.retry} onPress={start} />
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
                onShop={openShop}
                recent={recent}
                onOpenRecent={openRecent}
                onClearRecent={clearRecent}
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
                onShop={openShop}
                onBook={openBooking}
                onOpenSalon={openSalonFromHome}
                favoritesVersion={favoritesVersion}
                recent={recent}
                onClearRecent={clearRecent}
              />
            )}
          </View>
          {catalog ? (
            <View style={finder === catalog ? styles.fill : styles.hidden}>
              <CatalogScreen
                api={api}
                t={t}
                locale={locale}
                onLocale={changeLocale}
                initialQuery={catalog.query}
                initialOpenNow={catalog.openNow}
                initialBestRated={catalog.bestRated}
                onOpen={openSalon}
                onBack={back}
              />
            </View>
          ) : null}
          {/* Keep the product and search mounted while its salon or booking is open. */}
          {finderPath.some((screen) => screen.kind === 'shop') ? (
            <View style={finder?.kind === 'shop' ? styles.fill : styles.hidden}>
              <ShopScreen
                api={api}
                t={t}
                locale={locale}
                onBack={back}
                signedIn={stage.kind === 'visits'}
                onOpenSalon={openSalon}
                onBookWith={(s, productId) =>
                  setFinderPath([
                    ...finderPath,
                    {
                      kind: 'open',
                      slug: s.slug,
                      name: s.name,
                      preset: { productIds: [productId] },
                    },
                  ])
                }
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
              onBack={back}
              onLoaded={(salon) =>
                setFinderPath((path) =>
                  path.at(-1) === finder
                    ? [...path.slice(0, -1), { kind: 'book', salon, preset: finder.preset }]
                    : path,
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
              onBack={back}
              onFinished={(email) => {
                setFinderPath([]);
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
              onBack={back}
              onBook={(salon, preset) =>
                setFinderPath([...finderPath, { kind: 'book', salon, preset }])
              }
              signedIn={stage.kind === 'visits'}
              onFavoriteChanged={favoriteChanged}
              onViewed={salonViewed}
              onOpenSalon={(s) =>
                setFinderPath([
                  ...finderPath.slice(0, -1),
                  {
                    kind: 'salon',
                    slug: s.slug,
                    name: s.name,
                  },
                ])
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
