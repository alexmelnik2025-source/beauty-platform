import { useCallback, useEffect, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ApiError,
  type BusinessApi,
  type CancellationGuard,
  type GuardedClients,
  type Locale,
} from '../api';
import { errorText } from '../errors';
import { actionLine, clientReasons, guardToSave, hasRule, ruleLines } from '../guard';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 207: "Ochrona przed odwołaniami" — the owner or a manager sees the salon's rules,
 * switches the protection on or off (switching off asks first) and lifts a marked client's
 * block with an optional note. The rules are changed in the cabinet (a hint says so).
 */
export function GuardScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const g = t.guard;
  const [settings, setSettings] = useState<CancellationGuard | null>(null);
  const [marked, setMarked] = useState<GuardedClients | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [askOff, setAskOff] = useState(false);
  const [releaseId, setReleaseId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([
        api.guardSettings(salon.orgId, salon.locationId),
        api.guardedClients(salon.orgId, salon.locationId),
      ]);
      setSettings(s);
      setMarked(list);
      setError('');
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  async function run(action: () => Promise<void>, done: string) {
    setBusy(true);
    try {
      await action();
      await load();
      setInfo(done);
    } catch (e) {
      setInfo('');
      if (e instanceof ApiError && e.status === 409) {
        setError(g.conflict);
        await load();
      } else {
        setError(errorText(e, t));
      }
    } finally {
      setBusy(false);
    }
  }

  function switchTo(enabled: boolean) {
    if (!settings) return;
    setAskOff(false);
    if (enabled && !hasRule(settings)) return setError(g.needRule);
    void run(
      async () => {
        await api.saveGuardSettings(salon.orgId, salon.locationId, guardToSave(settings, enabled));
      },
      enabled ? g.turnedOn : g.turnedOff,
    );
  }

  function release(customerId: string) {
    const text = note;
    setReleaseId(null);
    setNote('');
    void run(async () => {
      await api.releaseGuard(salon.orgId, salon.locationId, customerId, text);
    }, g.released);
  }

  const rules = settings ? ruleLines(settings, t) : [];

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={g.back} onPress={onBack} />
      </View>
      <Heading>{g.title}</Heading>
      <Text style={styles.muted}>{g.hint}</Text>
      {info ? (
        <Text role="status" style={styles.info}>
          {info}
        </Text>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}

      {settings === null ? (
        !error ? (
          <Text style={styles.muted}>{t.loading}</Text>
        ) : null
      ) : (
        <>
          <Card>
            <Text style={styles.name}>{settings.enabled ? g.on : g.off}</Text>
            <Text style={styles.label}>{g.rules}</Text>
            {rules.length === 0 ? (
              <Text style={styles.muted}>{g.noRules}</Text>
            ) : (
              rules.map((line) => (
                <Text key={line} style={styles.text}>
                  {`• ${line}`}
                </Text>
              ))
            )}
            <Text style={styles.text}>{actionLine(settings.action, t)}</Text>
            {askOff ? (
              <View style={{ gap: 8 }}>
                <Text style={styles.text}>{g.offAsk}</Text>
                <View style={styles.row}>
                  <Button label={g.offYes} busy={busy} onPress={() => switchTo(false)} />
                  <Button kind="secondary" label={g.no} onPress={() => setAskOff(false)} />
                </View>
              </View>
            ) : settings.enabled ? (
              <Button kind="secondary" label={g.turnOff} onPress={() => setAskOff(true)} />
            ) : (
              <Button label={g.turnOn} busy={busy} onPress={() => switchTo(true)} />
            )}
            <Text style={styles.muted}>{g.cabinetHint}</Text>
          </Card>

          <Text style={styles.section} role="heading">
            {g.clients}
          </Text>
          {!settings.enabled ? (
            <Text style={styles.muted}>{g.offList}</Text>
          ) : !marked || marked.items.length === 0 ? (
            <Text style={styles.muted}>{g.none}</Text>
          ) : (
            marked.items.map((client) => (
              <Card key={client.customerId}>
                <Text style={styles.name}>{client.name}</Text>
                <Text style={styles.muted}>
                  {clientReasons(client, marked.currency, t, props.locale)}
                </Text>
                {releaseId === client.customerId ? (
                  <View style={{ gap: 8 }}>
                    <Text style={styles.text}>{g.releaseAsk}</Text>
                    <TextInput
                      accessibilityLabel={g.note}
                      placeholder={g.note}
                      placeholderTextColor={colors.placeholder}
                      value={note}
                      onChangeText={setNote}
                      style={styles.input}
                    />
                    <View style={styles.row}>
                      <Button
                        label={g.releaseYes}
                        busy={busy}
                        onPress={() => release(client.customerId)}
                      />
                      <Button kind="secondary" label={g.no} onPress={() => setReleaseId(null)} />
                    </View>
                  </View>
                ) : (
                  <Button
                    kind="link"
                    label={g.release}
                    a11yLabel={fill(g.releaseOne, { name: client.name })}
                    onPress={() => {
                      setReleaseId(client.customerId);
                      setNote('');
                    }}
                  />
                )}
              </Card>
            ))
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  name: { fontSize: 17, fontWeight: '600', color: colors.ink },
  section: { fontSize: 20, fontWeight: '700', color: colors.ink, marginTop: 12 },
  text: { fontSize: 15, color: colors.ink },
  label: { fontSize: 13, fontWeight: '700', color: colors.muted },
  muted: { color: colors.muted, fontSize: 15 },
  info: { color: '#2e7d32', fontSize: 15 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.ink,
  },
});
