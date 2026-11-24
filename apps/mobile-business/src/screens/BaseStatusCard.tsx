import { useEffect, useId, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { ApiError, type BaseIntegration, type BusinessApi } from '../api';
import { baseCardState, baseErrorText, lastSyncLine, runResultText } from '../baseStatus';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

export function BaseStatusCard(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  onSynced: () => void;
}) {
  const { api, t, salon, onSynced } = props;
  const s = t.shop.base;
  const [status, setStatus] = useState<BaseIntegration | null>(null);
  const summaryId = useId();
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setStatus(null);
    setError('');
    api.baseStatus(salon.orgId, salon.locationId).then(
      (next) => {
        if (alive) setStatus(next);
      },
      (e: unknown) => {
        if (alive) setError(errorText(e, t));
      },
    );
    return () => {
      alive = false;
    };
  }, [api, salon, t, attempt]);

  const sync = async () => {
    setBusy(true);
    setError('');
    setResult('');
    try {
      const run = await api.syncBase(salon.orgId, salon.locationId);
      setResult(runResultText(run, t));
      setAttempt((n) => n + 1);
      onSynced();
    } catch (e) {
      setError(e instanceof ApiError && e.code ? baseErrorText(e.code, t) : errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const title = (summary?: string) => (
    <Text
      style={styles.name}
      role="heading"
      aria-level={2}
      aria-describedby={summary ? summaryId : undefined}
      accessibilityLabel={Platform.OS !== 'web' && summary ? `${s.title}: ${summary}` : undefined}
    >
      {s.title}
    </Text>
  );
  if (!status) {
    return (
      <Card>
        {title()}
        {error ? (
          <>
            <ErrorText>{error}</ErrorText>
            <Button
              kind="secondary"
              label={t.day.refresh}
              a11yLabel={`${t.day.refresh}: ${s.title}`}
              onPress={() => setAttempt((n) => n + 1)}
            />
          </>
        ) : (
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={`${s.title}: ${t.loading}`}
            style={styles.skeleton}
          />
        )}
      </Card>
    );
  }
  const state = baseCardState(status);
  if (state.kind === 'off')
    return (
      <View accessible={false} role="group" accessibilityLabel={s.title}>
        <Card>
          {title(s.off)}
          <Text nativeID={summaryId} aria-hidden style={styles.small}>
            {s.off}
          </Text>
        </Card>
      </View>
    );

  const connected = fill(s.connected, {
    hint: status.tokenHint ?? '',
    n: String(status.importedProducts),
  });
  const lastSync = lastSyncLine(status, t);
  const warning =
    state.kind === 'fix'
      ? state.reason === 'reconnect'
        ? s.reconnect
        : s.configure
      : status.lastErrorCode
        ? lastSync
        : '';
  return (
    <View role="group" accessibilityLabel={s.title} accessible={false}>
      <Card>
        {title(warning || connected)}
        <Text
          nativeID={summaryId}
          aria-hidden={!warning}
          role={warning ? 'alert' : undefined}
          style={[styles.text, warning ? styles.warning : undefined]}
        >
          {warning || connected}
        </Text>
        <Button
          kind="secondary"
          label={`${t.navigation.more} ${expanded ? '▴' : '▸'}`}
          a11yLabel={`${t.navigation.more}: ${s.title}`}
          expanded={expanded}
          onPress={() => setExpanded(!expanded)}
        />
        {expanded && (
          <>
            <Text style={styles.small}>{warning ? connected : lastSync}</Text>
            {state.kind === 'on' && (
              <>
                <Text style={styles.small}>
                  {fill(s.every, { n: String(status.syncEveryMinutes) })}
                </Text>
                {result ? (
                  <Text accessibilityLiveRegion="polite" style={styles.text}>
                    {result}
                  </Text>
                ) : null}
                {error ? <ErrorText>{error}</ErrorText> : null}
                <Button label={s.syncNow} busy={busy} onPress={() => void sync()} />
              </>
            )}
          </>
        )}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: 17, fontWeight: '700', color: colors.ink },
  warning: { color: colors.danger },
  text: { fontSize: 15, color: colors.ink },
  small: { color: colors.muted, fontSize: 14 },
  skeleton: { height: 16, width: '75%', borderRadius: 4, backgroundColor: colors.soft },
});
