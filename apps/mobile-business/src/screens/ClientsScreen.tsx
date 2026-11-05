import { useCallback, useEffect, useState } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { BusinessApi, CustomerList, Locale } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import { ClientScreen } from './ClientScreen';
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

  const search = useCallback(
    async (text: string) => {
      setBusy(true);
      try {
        setList(await api.customers(salon.orgId, text, PAGE, inactiveDays));
        setSearched(text.trim());
        setError('');
      } catch (e) {
        setError(errorText(e, t));
      } finally {
        setBusy(false);
      }
    },
    [api, salon, t, inactiveDays],
  );

  useEffect(() => {
    void search('');
  }, [search]);

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
          placeholderTextColor="#a39e95"
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
      {error ? <ErrorText>{error}</ErrorText> : null}

      {list === null ? (
        !error ? (
          <Text style={styles.muted}>{t.loading}</Text>
        ) : null
      ) : list.length === 0 ? (
        <Text style={styles.muted}>{inactiveDays ? c.inactiveNone : c.none}</Text>
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
  tags: { color: colors.gold, fontSize: 14, fontWeight: '600' },
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
