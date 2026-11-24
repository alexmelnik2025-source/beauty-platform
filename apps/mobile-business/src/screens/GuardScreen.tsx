import { memo, useCallback, useEffect, useState } from 'react';
import { BackHandler, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ApiError,
  type BusinessApi,
  type CancellationGuard,
  type GuardedClients,
  type Locale,
} from '../api';
import { errorText } from '../errors';
import {
  actionLine,
  clientReasons,
  GUARD_ACTIONS,
  guardForm,
  guardRulesToSave,
  guardToSave,
  hasRule,
  ruleLines,
  type GuardForm,
  type MarkedClient,
} from '../guard';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
import type { SalonChoice } from './SalonsScreen';
import { SalonReadCache, useScreenLifetime } from './HistoryScreen';
const settingsCache = new SalonReadCache<CancellationGuard>();
const clientsCache = new SalonReadCache<GuardedClients>();

/**
 * Task 207: "Ochrona przed odwołaniami" — the owner or a manager sees the salon's rules,
 * switches the protection on or off (switching off asks first) and lifts a marked client's
 * block with an optional note. Task 349: "Zmień zasady" — which rules count (often cancels or
 * moves within N days, cancels late, misses visits) and what happens then.
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
  const [form, setForm] = useState<GuardForm | null>(null);

  const lifetime = useScreenLifetime(salon);
  const load = useCallback(async () => {
    const signal = lifetime.current!.signal;
    if (signal.aborted) return;
    try {
      const [s, list] = await Promise.all([
        settingsCache.read(salon, () => api.guardSettings(salon.orgId, salon.locationId)),
        clientsCache.read(salon, () => api.guardedClients(salon.orgId, salon.locationId)),
      ]);
      if (signal.aborted) return;
      setSettings(s);
      setMarked(list);
      setError('');
    } catch (e) {
      if (!signal.aborted) setError(errorText(e, t));
    }
  }, [api, salon, t, lifetime]);

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
    if (busy) return;
    const signal = lifetime.current!.signal;
    setBusy(true);
    try {
      await action();
      clientsCache.clear(salon);
      if (signal.aborted) return;
      await load();
      if (!signal.aborted) setInfo(done);
    } catch (e) {
      if (signal.aborted) return;
      setInfo('');
      if (e instanceof ApiError && e.status === 409) {
        settingsCache.clear(salon);
        clientsCache.clear(salon);
        setError(g.conflict);
        await load();
      } else {
        setError(errorText(e, t));
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  function switchTo(enabled: boolean) {
    if (!settings) return;
    setAskOff(false);
    if (enabled && !hasRule(settings)) return setError(g.needRule);
    void run(
      async () => {
        settingsCache.set(
          salon,
          await api.saveGuardSettings(
            salon.orgId,
            salon.locationId,
            guardToSave(settings, enabled),
          ),
        );
      },
      enabled ? g.turnedOn : g.turnedOff,
    );
  }

  function saveRules() {
    if (!settings || !form) return;
    const checked = guardRulesToSave(settings, form);
    if (!checked.ok) return setError(g.problem[checked.problem]);
    void run(async () => {
      settingsCache.set(
        salon,
        await api.saveGuardSettings(salon.orgId, salon.locationId, checked.save),
      );
      if (!lifetime.current!.signal.aborted) setForm(null);
    }, g.rulesSaved);
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
    <FlatList
      contentContainerStyle={styles.screen}
      keyboardShouldPersistTaps="handled"
      data={settings?.enabled ? (marked?.items ?? []) : []}
      keyExtractor={(client) => client.customerId}
      ListHeaderComponent={
        <View style={styles.header}>
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
                {!form ? (
                  <Button
                    kind="secondary"
                    label={g.rulesChange}
                    onPress={() => {
                      setForm(guardForm(settings));
                      setInfo('');
                      setError('');
                    }}
                  />
                ) : null}
              </Card>

              {form ? (
                <Card>
                  <Text style={styles.label}>{g.rules}</Text>
                  <Toggle
                    label={g.changesOn}
                    on={form.changesOn}
                    onPress={() => setForm({ ...form, changesOn: !form.changesOn })}
                  />
                  {form.changesOn ? (
                    <View style={styles.pair}>
                      <Field
                        label={g.changes}
                        value={form.changes}
                        onChange={(changes) => setForm({ ...form, changes })}
                      />
                      <Field
                        label={g.windowDays}
                        value={form.windowDays}
                        onChange={(windowDays) => setForm({ ...form, windowDays })}
                      />
                    </View>
                  ) : null}
                  <Toggle
                    label={g.lateOn}
                    on={form.lateOn}
                    onPress={() => setForm({ ...form, lateOn: !form.lateOn })}
                  />
                  {form.lateOn ? (
                    <Field
                      label={g.lateMinutes}
                      value={form.lateMinutes}
                      onChange={(lateMinutes) => setForm({ ...form, lateMinutes })}
                    />
                  ) : null}
                  <Toggle
                    label={g.noShowsOn}
                    on={form.noShowsOn}
                    onPress={() => setForm({ ...form, noShowsOn: !form.noShowsOn })}
                  />
                  {form.noShowsOn ? (
                    <Field
                      label={g.noShows}
                      value={form.noShows}
                      onChange={(noShows) => setForm({ ...form, noShows })}
                    />
                  ) : null}
                  <Text style={styles.label}>{g.actionLabel}</Text>
                  <View role="radiogroup" accessibilityLabel={g.actionLabel} style={{ gap: 8 }}>
                    {GUARD_ACTIONS.map((action) => (
                      <Pressable
                        accessibilityLabel={g.actions[action]}
                        key={action}
                        role="radio"
                        aria-checked={form.action === action}
                        accessibilityState={{ checked: form.action === action }}
                        onPress={() => setForm({ ...form, action })}
                        style={[styles.choice, form.action === action && styles.choiceOn]}
                      >
                        <Text style={[styles.text, form.action === action && { color: '#fff' }]}>
                          {g.actions[action]}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <View style={styles.row}>
                    <Button label={g.rulesSave} busy={busy} onPress={saveRules} />
                    <Button kind="secondary" label={g.cancel} onPress={() => setForm(null)} />
                  </View>
                </Card>
              ) : null}

              <Text style={styles.section} role="heading">
                {g.clients}
              </Text>
              {!settings.enabled ? (
                <Text style={styles.muted}>{g.offList}</Text>
              ) : !marked || marked.items.length === 0 ? (
                <Text style={styles.muted}>{g.none}</Text>
              ) : null}
            </>
          )}
        </View>
      }
      renderItem={({ item: client }) => (
        <Card>
          <ClientDetails client={client} currency={marked!.currency} locale={props.locale} t={t} />
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
      )}
    />
  );
}

const ClientDetails = memo(function ClientDetails({
  client,
  currency,
  t,
  locale,
}: {
  client: MarkedClient;
  currency: string;
  t: Dictionary;
  locale: Locale;
}) {
  return (
    <>
      <Text style={styles.name}>{client.name}</Text>
      <Text style={styles.muted}>{clientReasons(client, currency, t, locale)}</Text>
    </>
  );
});

function Toggle(props: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      role="checkbox"
      aria-checked={props.on}
      accessibilityState={{ checked: props.on }}
      onPress={props.onPress}
      style={styles.toggle}
    >
      <View style={[styles.box, props.on && styles.boxOn]}>
        {props.on ? <Text style={{ color: '#fff', fontWeight: '700' }}>✓</Text> : null}
      </View>
      <Text style={styles.text}>{props.label}</Text>
    </Pressable>
  );
}

function Field(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <View style={{ gap: 4, flex: 1, minWidth: 140 }}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        keyboardType="number-pad"
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  toggle: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 6 },
  box: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  boxOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  choice: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.card,
  },
  choiceOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  header: { gap: 12 },
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
