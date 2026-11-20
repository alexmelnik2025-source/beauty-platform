import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { ApiError, type BaseIntegration, type BusinessApi } from '../api';
import { baseCardState, baseErrorText, lastSyncLine, runResultText } from '../baseStatus';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task Q4: Base on the phone — a card at the top of "Mój sklep" for owners and managers. Not
 * connected: one quiet line (connecting is done in the cabinet, "Integracje"). Connected: how many
 * products came from Base, when prices and stock were renewed and whether it went well, and
 * "Synchronizuj teraz" with what it did. `onSynced` reloads the products above.
 */
export function BaseStatusCard(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  onSynced: () => void;
}) {
  const { api, t, salon, onSynced } = props;
  const s = t.shop.base;
  const [status, setStatus] = useState<BaseIntegration | null>(null);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setStatus(await api.baseStatus(salon.orgId, salon.locationId));
  }, [api, salon]);

  useEffect(() => {
    load().catch((e: unknown) => setError(errorText(e, t)));
  }, [load, t]);

  const sync = async () => {
    setBusy(true);
    setError('');
    setResult('');
    try {
      const run = await api.syncBase(salon.orgId, salon.locationId);
      setResult(runResultText(run, t));
      await load();
      onSynced();
    } catch (e) {
      setError(e instanceof ApiError && e.code ? baseErrorText(e.code, t) : errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return error ? <ErrorText>{error}</ErrorText> : null;
  const state = baseCardState(status);
  if (state.kind === 'off') return <Text style={styles.small}>{s.off}</Text>;

  return (
    <Card>
      <Text style={styles.name}>{s.title}</Text>
      <Text style={styles.text}>
        {fill(s.connected, {
          hint: status.tokenHint ?? '',
          n: String(status.importedProducts),
        })}
      </Text>
      {state.kind === 'fix' ? (
        <Text style={styles.warn}>{state.reason === 'reconnect' ? s.reconnect : s.configure}</Text>
      ) : (
        <>
          <Text style={status.lastErrorCode ? styles.warn : styles.small}>
            {lastSyncLine(status, t)}
          </Text>
          <Text style={styles.small}>{fill(s.every, { n: String(status.syncEveryMinutes) })}</Text>
          {result ? <Text style={styles.text}>{result}</Text> : null}
          {error ? <ErrorText>{error}</ErrorText> : null}
          <Button kind="secondary" label={s.syncNow} busy={busy} onPress={() => void sync()} />
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: 17, fontWeight: '700', color: colors.ink },
  text: { fontSize: 15, color: colors.ink },
  small: { color: colors.muted, fontSize: 14 },
  warn: { color: colors.danger, fontSize: 14 },
});
