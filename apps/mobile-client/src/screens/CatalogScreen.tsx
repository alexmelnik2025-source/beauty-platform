import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ClientApi, DirectorySalon, Locale, Specialty, SpokenLanguage } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { LanguageRow } from '../LanguageRow';
import { LANGUAGE_CHIP } from '../map';
import { SalonMap } from '../SalonMap';
import { formatPrice } from '../format';
import { addressText, filterSalons } from '../salon';
import { Button, Card, Chip, colors, ErrorText, Heading } from '../ui';

const SPOKEN: SpokenLanguage[] = ['pl', 'uk', 'ru', 'be', 'en'];
const KINDS: Specialty[] = [
  'barber',
  'hairdresser',
  'nails',
  'cosmetologist',
  'brows_lashes',
  'makeup',
  'massage',
];
/** Task 160: the map shows up to this many salons at once (the list still pages). */
const MAP_PAGE = 50;

/**
 * The catalogue: salons open for online booking, filtered by the language the client wants to
 * be served in (salon or one of its specialists speaks it) and by name / city / street.
 */
export function CatalogScreen(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  onLocale: (locale: Locale) => void;
  onOpen: (salon: DirectorySalon) => void;
  /** Back to sign-in or "My visits", where the catalogue was opened from. */
  onBack: () => void;
}) {
  const { api, t } = props;
  const [language, setLanguage] = useState<SpokenLanguage | null>(null);
  // Task 160: the catalogue opens on the map; the kind of place is the second filter.
  const [view, setView] = useState<'map' | 'list'>('map');
  const [specialty, setSpecialty] = useState<Specialty | null>(null);
  const [languageCounts, setLanguageCounts] = useState<Partial<Record<SpokenLanguage, number>>>({});
  const [specialtyCounts, setSpecialtyCounts] = useState<Partial<Record<Specialty, number>>>({});
  const [items, setItems] = useState<DirectorySalon[]>([]);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(
    async (nextPage: number, append: boolean) => {
      setBusy(true);
      setError('');
      try {
        const res = await api.directory({
          page: nextPage,
          pageSize: MAP_PAGE,
          language: language ?? undefined,
          specialty: specialty ?? undefined,
        });
        setLanguageCounts(res.languageCounts);
        setSpecialtyCounts(res.specialtyCounts);
        setItems((old) => (append ? [...old, ...res.items] : res.items));
        setPage(res.page);
        setPageCount(res.pageCount);
        setTotal(res.total);
      } catch (e) {
        setError(errorText(e, tRef.current));
      } finally {
        setBusy(false);
      }
    },
    // The texts follow the app language, but switching it does not reload the list.
    [api, language, specialty],
  );

  useEffect(() => {
    void load(1, false);
  }, [load]);

  const shown = useMemo(() => filterSalons(items, query), [items, query]);

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.top}>
        <Button kind="link" label={t.salon.back} onPress={props.onBack} />
      </View>
      <Heading>{t.catalog.title}</Heading>
      <Text style={styles.text}>{t.catalog.lead}</Text>
      <TextInput
        accessibilityLabel={t.catalog.search}
        placeholder={t.catalog.search}
        placeholderTextColor="#a39e95"
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        inputMode="search"
        style={styles.input}
      />
      <View style={styles.chips} accessibilityLabel={t.catalog.filterLanguage}>
        <Chip
          label={t.catalog.allLanguages}
          pressed={language === null}
          onPress={() => setLanguage(null)}
        />
        {SPOKEN.map((l) => (
          <Chip
            key={l}
            label={`${LANGUAGE_CHIP[l]} (${languageCounts[l] ?? 0})`}
            a11yLabel={`${t.spoken[l]} (${languageCounts[l] ?? 0})`}
            pressed={language === l}
            onPress={() => setLanguage(l)}
          />
        ))}
      </View>
      {KINDS.some((k) => (specialtyCounts[k] ?? 0) > 0) ? (
        <View style={styles.chips} accessibilityLabel={t.catalog.filterKind}>
          <Chip
            label={t.catalog.allKinds}
            pressed={specialty === null}
            onPress={() => setSpecialty(null)}
          />
          {KINDS.filter((k) => (specialtyCounts[k] ?? 0) > 0 || specialty === k).map((k) => (
            <Chip
              key={k}
              label={`${t.specialty[k]} (${specialtyCounts[k] ?? 0})`}
              pressed={specialty === k}
              onPress={() => setSpecialty(k)}
            />
          ))}
        </View>
      ) : null}
      <View style={styles.chips} accessibilityLabel={t.catalog.view}>
        <Chip label={t.catalog.viewMap} pressed={view === 'map'} onPress={() => setView('map')} />
        <Chip
          label={t.catalog.viewList}
          pressed={view === 'list'}
          onPress={() => setView('list')}
        />
      </View>
      {view === 'map' && !error ? (
        <SalonMap
          api={api}
          t={t}
          locale={props.locale}
          salons={shown}
          language={language}
          onOpen={props.onOpen}
        />
      ) : null}
      {error ? (
        <View style={{ gap: 12 }}>
          <ErrorText>{error}</ErrorText>
          <Button kind="secondary" label={t.retry} onPress={() => load(1, false)} />
        </View>
      ) : null}
      {!error && !busy ? (
        <Text style={styles.text}>{fill(t.catalog.found, { n: String(total) })}</Text>
      ) : null}
      {!error && !busy && total === 0 ? <Text style={styles.text}>{t.catalog.empty}</Text> : null}
      {!error && !busy && total > 0 && shown.length === 0 ? (
        <Text style={styles.text}>{t.catalog.noMatch}</Text>
      ) : null}
      {shown.map((s) => (
        <View key={s.slug} role="article" aria-label={s.name}>
          <Card>
            <Text style={styles.name}>{s.name}</Text>
            <Text style={styles.text}>{addressText(s)}</Text>
            {s.priceFromGrosze !== null ? (
              <Text style={styles.price}>
                {fill(t.catalog.priceFrom, {
                  price: formatPrice(s.priceFromGrosze, s.currency, props.locale),
                })}
              </Text>
            ) : null}
            {language && s.staffSpeaking ? (
              <Text style={styles.small}>
                {fill(t.catalog.speakingStaff, {
                  language: t.spoken[language],
                  n: String(s.staffSpeaking),
                })}
              </Text>
            ) : null}
            {s.languages.length > 0 ? (
              <Text
                role="note"
                aria-label={`${t.salon.speaks}: ${s.languages.map((l) => t.spoken[l]).join(', ')}`}
                style={styles.small}
              >
                {t.salon.speaks}: {s.languages.map((l) => t.spoken[l]).join(', ')}
              </Text>
            ) : null}
            <View style={{ marginTop: 8 }}>
              <Button kind="secondary" label={t.catalog.open} onPress={() => props.onOpen(s)} />
            </View>
          </Card>
        </View>
      ))}
      {busy ? <ActivityIndicator style={{ marginTop: 16 }} color={colors.ink} /> : null}
      {!busy && !error && page < pageCount ? (
        <Button kind="secondary" label={t.catalog.more} onPress={() => load(page + 1, true)} />
      ) : null}
      <LanguageRow label={t.language} locale={props.locale} onLocale={props.onLocale} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 14 },
  top: { flexDirection: 'row', marginLeft: -8 },
  text: { color: colors.muted, fontSize: 15, lineHeight: 21 },
  small: { color: colors.muted, fontSize: 14 },
  price: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  name: { fontSize: 18, fontWeight: '700', color: colors.ink },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.ink,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
