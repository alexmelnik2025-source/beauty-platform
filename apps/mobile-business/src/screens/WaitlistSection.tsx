import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText } from '../ui';
import { waitlistOfDay, waitlistStatus, type WaitlistEntry } from '../waitlist';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 94: "Lista oczekujących" under the day's visits — clients who want a time on this
 * (full) day, with their contacts, for owners and managers (the server checks it too).
 * "+ Nowa wizyta" opens the new-visit form filled in for the client; "Usuń z listy" removes
 * them without a message. Nothing is shown when nobody waits or for days already gone.
 */
export function WaitlistSection(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  date: string;
  today: string;
  timeZone: string;
  /** Changes when the day is read again (pull to refresh, every 30 s, after a new visit). */
  reload: number;
  onBook: (entry: WaitlistEntry) => void;
}) {
  const { api, t, salon, date } = props;
  const w = t.waitlist;
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const past = date < props.today;

  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    if (past) return setEntries([]);
    try {
      const list = await api.waitlist(salon.orgId, salon.locationId, date);
      if (request === latest.current) setEntries(waitlistOfDay(list, date));
    } catch {
      // Not allowed or offline: the calendar above shows its own error.
      if (request === latest.current) setEntries([]);
    }
  }, [api, salon, date, past]);

  useEffect(() => {
    setEntries([]);
    setInfo('');
    setConfirm(null);
  }, [date]);

  useEffect(() => {
    void load();
  }, [load, props.reload]);

  async function remove(entry: WaitlistEntry) {
    setBusy(true);
    setError('');
    try {
      await api.removeFromWaitlist(salon.orgId, salon.locationId, entry.id);
      setEntries((list) => list.filter((e) => e.id !== entry.id));
      setInfo(fill(w.removed, { name: entry.name }));
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setConfirm(null);
      setBusy(false);
    }
  }

  if (entries.length === 0 && !info && !error) return null;

  return (
    <View style={styles.wrap} accessibilityLabel={w.title}>
      <Text style={styles.section}>
        {w.title} ({entries.length})
      </Text>
      {entries.length > 0 ? <Text style={styles.muted}>{w.hint}</Text> : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {info ? <Text style={styles.info}>{info}</Text> : null}
      {entries.map((e) => (
        <Card key={e.id}>
          <Text style={styles.name}>{e.name}</Text>
          <Text style={styles.muted}>
            {e.serviceName} · {e.staffName ?? w.anyStaff}
          </Text>
          <View style={styles.row}>
            {e.phone ? (
              <Button
                kind="link"
                label={e.phone}
                onPress={() => void Linking.openURL(`tel:${e.phone}`)}
              />
            ) : null}
            <Button
              kind="link"
              label={e.email}
              onPress={() => void Linking.openURL(`mailto:${e.email}`)}
            />
          </View>
          <Text style={styles.small}>{waitlistStatus(e, props.timeZone, w)}</Text>
          {confirm === e.id ? (
            <View style={styles.row}>
              <Text style={styles.muted}>{fill(w.removeAsk, { name: e.name })}</Text>
              <Button label={w.removeYes} busy={busy} onPress={() => void remove(e)} />
              <Button kind="secondary" label={w.removeNo} onPress={() => setConfirm(null)} />
            </View>
          ) : (
            <View style={styles.row}>
              <Button
                kind="secondary"
                label={w.book}
                a11yLabel={fill(w.bookFor, { name: e.name })}
                onPress={() => props.onBook(e)}
              />
              <Button
                kind="link"
                label={w.remove}
                a11yLabel={`${w.remove}: ${e.name}`}
                onPress={() => {
                  setInfo('');
                  setConfirm(e.id);
                }}
              />
            </View>
          )}
        </Card>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10, marginTop: 8 },
  section: { marginTop: 8, fontSize: 13, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  name: { fontSize: 17, fontWeight: '600', color: colors.ink },
  info: { color: '#2e7d32', fontSize: 15 },
});
