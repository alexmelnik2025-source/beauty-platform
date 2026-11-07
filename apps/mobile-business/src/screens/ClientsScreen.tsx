import { useCallback, useEffect, useState } from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { BusinessApi, CustomerList, CustomerTags, Locale } from '../api';
import { birthdayText } from '../clients';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { shareCsv } from '../share';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import { ClientScreen } from './ClientScreen';
import { csvTools } from './csvTools';
import type { SalonChoice } from './SalonsScreen';

const PAGE = 50;
/** Task 140: "who hasn't been for a while" — 0 = everyone. */
const INACTIVE = [0, 30, 60, 90, 180] as const;

/** Owner or manager: the salon's clients, search by name, phone, email or tag → the client card. */
export function ClientsScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  timeZone: string;
  /** Task 249: open with "Nowi (30 dni)" on (from the report). */
  newcomers?: boolean;
  /** Task 263: open with "Pora wrócić" on (from the report). */
  overdue?: boolean;
  /** Task 265: open with "Nie przyszli" on (from the report). */
  noShows?: boolean;
  /** Task 271: open with "Byli tylko raz" on (from the report). */
  once?: boolean;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const c = t.clients;
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [list, setList] = useState<CustomerList | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [inactiveDays, setInactiveDays] = useState(0);
  // Task 224: only clients with this label; '' = everyone.
  const [tag, setTag] = useState('');
  const [tags, setTags] = useState<CustomerTags['tags']>([]);
  // Task 240: only clients with a birthday in the next 7 days.
  const [birthdays, setBirthdays] = useState(false);
  // Task 245: only clients who agreed to the salon messages.
  const [consented, setConsented] = useState(false);
  // Task 248: only clients whose first visit was in the last 30 days, newest first.
  const [newcomers, setNewcomers] = useState(props.newcomers ?? false);
  // Task 262: only regular clients past their usual break with nothing booked.
  const [overdue, setOverdue] = useState(props.overdue ?? false);
  // Task 264: only clients who did not come at least once in the last year.
  const [noShows, setNoShows] = useState(props.noShows ?? false);
  // Task 270: only clients who came once (30–365 days ago) and have nothing booked.
  const [once, setOnce] = useState(props.once ?? false);
  // Task 269: the owner downloads all clients as the cabinet's CSV.
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvInfo, setCsvInfo] = useState('');

  const downloadCsv = async () => {
    if (csvBusy) return;
    setCsvBusy(true);
    setCsvInfo('');
    try {
      const file = await api.clientsCsv(salon.orgId, props.locale);
      const result = await shareCsv(file, csvTools());
      setCsvInfo(result === 'failed' ? c.csvFailed : '');
    } catch (e) {
      setCsvInfo(errorText(e, t));
    } finally {
      setCsvBusy(false);
    }
  };

  const search = useCallback(
    async (text: string) => {
      setBusy(true);
      try {
        setList(
          await api.customers(
            salon.orgId,
            text,
            PAGE,
            inactiveDays,
            tag,
            birthdays ? 7 : 0,
            consented,
            newcomers ? 30 : 0,
            overdue,
            noShows,
            once,
          ),
        );
        setSearched(text.trim());
        setError('');
      } catch (e) {
        setError(errorText(e, t));
      } finally {
        setBusy(false);
      }
    },
    [api, salon, t, inactiveDays, tag, birthdays, consented, newcomers, overdue, noShows, once],
  );

  const loadTags = useCallback(async () => {
    try {
      setTags((await api.customerTags(salon.orgId)).tags);
    } catch {
      setTags([]);
    }
  }, [api, salon]);

  useEffect(() => {
    void search('');
  }, [search]);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  // Android "back" goes to the day, unless a client card is open (it handles "back" itself).
  useEffect(() => {
    if (openId) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack, openId]);

  if (openId) {
    return (
      <ClientScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        id={openId}
        timeZone={props.timeZone}
        onBack={() => {
          setOpenId(null);
          void search(searched);
          void loadTags();
        }}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={c.back} onPress={onBack} />
      </View>
      <Heading>{c.title}</Heading>
      <View style={styles.searchRow}>
        <TextInput
          accessibilityLabel={c.search}
          placeholder={c.search}
          placeholderTextColor={colors.placeholder}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => void search(query)}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <Button label={c.find} busy={busy} onPress={() => void search(query)} />
      </View>
      <Text style={styles.muted}>{c.inactive}</Text>
      <View style={styles.row} accessibilityRole="radiogroup">
        {INACTIVE.map((days) => (
          <Pressable
            key={days}
            accessibilityRole="radio"
            accessibilityState={{ checked: days === inactiveDays }}
            onPress={() => {
              setQuery('');
              setInactiveDays(days);
            }}
            style={[styles.chip, days === inactiveDays && styles.chipOn]}
          >
            <Text style={[styles.chipText, days === inactiveDays && styles.chipTextOn]}>
              {days === 0 ? c.inactiveAll : fill(c.inactiveDays, { days: String(days) })}
            </Text>
          </Pressable>
        ))}
      </View>
      {inactiveDays ? <Text style={styles.muted}>{c.inactiveHint}</Text> : null}
      <View style={styles.row}>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: birthdays }}
          onPress={() => setBirthdays(!birthdays)}
          style={[styles.chip, birthdays && styles.chipOn]}
        >
          <Text style={[styles.chipText, birthdays && styles.chipTextOn]}>🎂 {c.birthdays}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: consented }}
          accessibilityHint={c.consentedHint}
          onPress={() => setConsented(!consented)}
          style={[styles.chip, consented && styles.chipOn]}
        >
          <Text style={[styles.chipText, consented && styles.chipTextOn]}>✉️ {c.consented}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: newcomers }}
          accessibilityHint={c.newcomersHint}
          onPress={() => setNewcomers(!newcomers)}
          style={[styles.chip, newcomers && styles.chipOn]}
        >
          <Text style={[styles.chipText, newcomers && styles.chipTextOn]}>🌱 {c.newcomers}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: overdue }}
          accessibilityHint={c.overdueHint}
          onPress={() => setOverdue(!overdue)}
          style={[styles.chip, overdue && styles.chipOn]}
        >
          <Text style={[styles.chipText, overdue && styles.chipTextOn]}>⏰ {c.overdue}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: noShows }}
          accessibilityHint={c.missedHint}
          onPress={() => setNoShows(!noShows)}
          style={[styles.chip, noShows && styles.chipOn]}
        >
          <Text style={[styles.chipText, noShows && styles.chipTextOn]}>🚫 {c.missed}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: once }}
          accessibilityHint={c.onceHint}
          onPress={() => setOnce(!once)}
          style={[styles.chip, once && styles.chipOn]}
        >
          <Text style={[styles.chipText, once && styles.chipTextOn]}>👋 {c.once}</Text>
        </Pressable>
      </View>
      {newcomers ? <Text style={styles.muted}>{c.newcomersHint}</Text> : null}
      {overdue ? <Text style={styles.muted}>{c.overdueHint}</Text> : null}
      {noShows ? <Text style={styles.muted}>{c.missedHint}</Text> : null}
      {once ? <Text style={styles.muted}>{c.onceHint}</Text> : null}
      {tags.length > 0 ? (
        <>
          <Text style={styles.muted}>{c.tagFilter}</Text>
          <View style={styles.row} accessibilityRole="radiogroup">
            {[{ tag: '', clients: 0 }, ...tags].map((item) => (
              <Pressable
                key={item.tag || '*'}
                accessibilityRole="radio"
                accessibilityState={{ checked: item.tag === tag }}
                onPress={() => {
                  setQuery('');
                  setTag(item.tag === tag ? '' : item.tag);
                }}
                style={[styles.chip, item.tag === tag && styles.chipOn]}
              >
                <Text style={[styles.chipText, item.tag === tag && styles.chipTextOn]}>
                  {item.tag ? `${item.tag} · ${item.clients}` : c.allTags}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {salon.role === 'owner' ? (
        <View style={styles.csv}>
          <View style={styles.row}>
            <Button
              kind="secondary"
              label={c.csv}
              busy={csvBusy}
              onPress={() => void downloadCsv()}
            />
          </View>
          <Text style={styles.small}>{Platform.OS === 'web' ? c.csvHint : c.csvHintPhone}</Text>
          {csvInfo ? <ErrorText>{csvInfo}</ErrorText> : null}
        </View>
      ) : null}

      {list === null ? (
        !error ? (
          <Text style={styles.muted}>{t.loading}</Text>
        ) : null
      ) : list.length === 0 ? (
        <Text style={styles.muted}>
          {birthdays
            ? c.birthdaysNone
            : newcomers
              ? c.newcomersNone
              : overdue
                ? c.overdueNone
                : noShows
                  ? c.missedNone
                  : once
                    ? c.onceNone
                    : consented
                      ? c.consentedNone
                      : inactiveDays
                        ? c.inactiveNone
                        : c.none}
        </Text>
      ) : (
        <>
          {!searched && list.length >= PAGE ? (
            <Text style={styles.muted}>{fill(c.first, { count: String(PAGE) })}</Text>
          ) : null}
          {list.map((client) => (
            <Pressable
              key={client.id}
              accessibilityRole="button"
              accessibilityLabel={`${c.card}: ${client.name}`}
              onPress={() => setOpenId(client.id)}
              style={({ pressed }) => pressed && { opacity: 0.7 }}
            >
              <Card>
                <Text style={styles.name}>{client.name}</Text>
                {client.phone || client.email ? (
                  <Text style={styles.muted}>
                    {[client.phone, client.email].filter(Boolean).join(' · ')}
                  </Text>
                ) : null}
                {client.birthday ? (
                  <Text style={styles.muted}>
                    🎂{' '}
                    {birthdayText(client.birthday, props.locale, c.birthdayToday, props.timeZone)}
                  </Text>
                ) : null}
                {client.tags && client.tags.length > 0 ? (
                  <Text style={styles.tags}>{client.tags.join(' · ')}</Text>
                ) : null}
              </Card>
            </Pressable>
          ))}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  searchRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.ink,
  },
  name: { fontSize: 17, fontWeight: '600', color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  csv: { gap: 6 },
  tags: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { color: colors.ink, fontSize: 14 },
  chipTextOn: { color: '#fff', fontWeight: '600' },
});
