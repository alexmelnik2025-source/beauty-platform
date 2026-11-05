import { useCallback, useEffect, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, Locale } from '../api';
import { errorText } from '../errors';
import { appendPage, historyLine, historyTitle, type HistoryEntry } from '../history';
import type { Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 150: "Dziennik zmian" — the owner sees on the phone who changed services, the team,
 * schedules, rights, clients, loyalty and settings, and when. Newest first, 50 at a time.
 */
export function HistoryScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  timeZone: string;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const h = t.history;
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (before?: string) => {
      setBusy(true);
      try {
        const page = await api.auditLog(salon.orgId, before);
        setItems((shown) => (before && shown ? appendPage(shown, page.items) : page.items));
        setNext(page.next);
        setError('');
      } catch (e) {
        setError(errorText(e, t));
      } finally {
        setBusy(false);
      }
    },
    [api, salon, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Android's back button closes the screen instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Button kind="link" label={h.back} onPress={onBack} />
      <Heading>{h.title}</Heading>
      <Text style={styles.muted}>{h.hint}</Text>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {items === null ? (
        error ? null : (
          <Text style={styles.muted}>{t.loading}</Text>
        )
      ) : items.length === 0 ? (
        <Text style={styles.muted}>{h.empty}</Text>
      ) : (
        <Card>
          {items.map((e, i) => (
            <View key={e.id} style={[styles.row, i > 0 && styles.divider]}>
              <Text style={styles.title}>{historyTitle(e, t)}</Text>
              <Text style={styles.muted}>{historyLine(e, t, props.locale, props.timeZone)}</Text>
            </View>
          ))}
        </Card>
      )}
      {next ? (
        <Button kind="secondary" label={h.more} busy={busy} onPress={() => void load(next)} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  row: { paddingVertical: 10, gap: 2 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  title: { fontSize: 16, fontWeight: '600', color: colors.ink },
  muted: { color: colors.muted, fontSize: 14 },
});
