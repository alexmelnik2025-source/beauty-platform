import { memo, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, SalonWaitlist } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText } from '../ui';
import { waitlistOfDay, waitlistStatus, type WaitlistEntry } from '../waitlist';
import type { SalonChoice } from './SalonsScreen';
import { SalonReadCache, withNetworkTimeout } from './HistoryScreen';

const waitlistCache = new SalonReadCache<SalonWaitlist>();

interface Props {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  date: string;
  today: string;
  timeZone: string;
  /** Changes when the day is read again (pull to refresh, every 30 s, after a new visit). */
  reload: number;
  onBook: (entry: WaitlistEntry) => void;
}

/**
 * Task 94: "Lista oczekujących" under the day's visits — clients who want a time on this
 * (full) day, with their contacts, for owners and managers (the server checks it too).
 * "+ Nowa wizyta" opens the new-visit form filled in for the client; "Usuń z listy" removes
 * them without a message. Past days have no waiting list.
 */
export function WaitlistSection(props: Props) {
  const key = JSON.stringify([
    props.salon.orgId,
    props.salon.locationId,
    props.date,
    props.date < props.today,
  ]);
  return <DayWaitlist key={key} {...props} />;
}

function DayWaitlist(props: Props) {
  const { api, t, salon, date } = props;
  const w = t.waitlist;
  const [entries, setEntries] = useState<WaitlistEntry[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const past = date < props.today;

  const { orgId, locationId } = salon;
  const scope = useRef<AbortController | null>(null);
  const pending = useRef<Promise<SalonWaitlist> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    return () => {
      controller.abort();
      pending.current = null;
    };
  }, [api, orgId, locationId, date, past]);

  useEffect(() => {
    if (past) return;
    let active = true;
    // Calendar refreshes may overlap on a slow connection. Share the current day's read.
    const request =
      pending.current ??
      waitlistCache.read(
        salon,
        () => withNetworkTimeout(api.waitlist(orgId, locationId, date)),
        JSON.stringify([date, props.reload]),
      );
    pending.current = request;
    request.then(
      (list) => {
        if (!active || pending.current !== request) return;
        pending.current = null;
        setReadError('');
        const next = waitlistOfDay(list, date);
        setEntries((previous) => (previous?.length === 0 && !next.length ? previous : next));
      },
      (cause: unknown) => {
        if (!active || pending.current !== request) return;
        pending.current = null;
        setReadError(errorText(cause, t));
      },
    );
    return () => {
      active = false;
    };
  }, [api, salon, orgId, locationId, date, past, props.reload, attempt, t]);

  async function remove(entry: WaitlistEntry) {
    const signal = scope.current?.signal;
    if (!signal || signal.aborted || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await api.removeFromWaitlist(salon.orgId, salon.locationId, entry.id);
      waitlistCache.clear(salon);
      if (signal.aborted) return;
      // A refresh started before this removal may still contain the entry.
      pending.current = null;
      setEntries((list) => list?.filter((e) => e.id !== entry.id) ?? null);
      setConfirm(null);
      setInfo(fill(w.removed, { name: entry.name }));
    } catch (e) {
      if (!signal.aborted) setError(errorText(e, t));
    } finally {
      submitting.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  if (!entries && !readError) return null;

  return (
    <View style={styles.wrap} accessibilityLabel={w.title}>
      <Text role="heading" style={styles.section}>
        {entries ? `${w.title} (${entries.length})` : w.title}
      </Text>
      {readError ? (
        <>
          <Text role="status" accessibilityLiveRegion="polite" style={styles.readError}>
            {readError}
          </Text>
          <Button
            kind="secondary"
            label={t.day.refresh}
            a11yLabel={`${t.day.refresh}: ${w.title}`}
            onPress={() => setAttempt((n) => n + 1)}
          />
        </>
      ) : null}
      {entries?.length ? <Text style={styles.muted}>{w.hint}</Text> : null}
      {info ? (
        <Text role="status" style={styles.info}>
          {info}
        </Text>
      ) : null}
      {entries?.map((e) => (
        <Card key={e.id}>
          <WaitlistDetails entry={e} timeZone={props.timeZone} w={w} />
          {confirm === e.id ? (
            <>
              {error ? <ErrorText>{error}</ErrorText> : null}
              <Text style={styles.muted}>{fill(w.removeAsk, { name: e.name })}</Text>
              <View style={styles.row}>
                <Button label={w.removeYes} busy={busy} onPress={() => void remove(e)} />
                <Button
                  kind="secondary"
                  label={w.removeNo}
                  disabled={busy}
                  onPress={() => setConfirm(null)}
                />
              </View>
            </>
          ) : (
            <View style={styles.row}>
              <Button
                kind="secondary"
                label={w.book}
                disabled={busy}
                a11yLabel={fill(w.bookFor, { name: e.name })}
                onPress={() => props.onBook(e)}
              />
              <Button
                kind="link"
                label={w.remove}
                disabled={busy}
                a11yLabel={`${w.remove}: ${e.name}`}
                onPress={() => {
                  setInfo('');
                  setError('');
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

const WaitlistDetails = memo(function WaitlistDetails({
  entry,
  timeZone,
  w,
}: {
  entry: WaitlistEntry;
  timeZone: string;
  w: Dictionary['waitlist'];
}) {
  return (
    <>
      <View accessible style={styles.row}>
        <Text style={styles.name}>{entry.name}</Text>
        {entry.autoBook ? <Text style={styles.autoBadge}>Auto</Text> : null}
      </View>
      <Text style={styles.muted}>
        {entry.serviceName} · {entry.staffName ?? w.anyStaff}
      </Text>
      <View style={styles.row}>
        {entry.phone ? (
          <Button
            kind="link"
            label={entry.phone}
            onPress={() => void Linking.openURL(`tel:${entry.phone}`)}
          />
        ) : null}
        <Button
          kind="link"
          label={entry.email}
          onPress={() => void Linking.openURL(`mailto:${entry.email}`)}
        />
      </View>
      <Text style={styles.small}>{waitlistStatus(entry, timeZone, w)}</Text>
    </>
  );
});

const styles = StyleSheet.create({
  wrap: { gap: 10, marginTop: 8 },
  section: { marginTop: 8, fontSize: 13, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  autoBadge: {
    backgroundColor: colors.soft,
    color: colors.ink,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontWeight: '600',
  },
  muted: { color: colors.muted, fontSize: 15 },
  readError: { color: colors.danger, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  name: { maxWidth: '100%', flexShrink: 1, fontSize: 17, fontWeight: '600', color: colors.ink },
  info: { color: '#2e7d32', fontSize: 15 },
});
