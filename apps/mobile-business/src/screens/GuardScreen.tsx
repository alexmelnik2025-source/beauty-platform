import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { BackHandler, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ApiError,
  type BusinessApi,
  type CancellationGuard,
  type GuardedClients,
  type Locale,
} from '../api';
import { errorText } from '../errors';
import { useFormDraft } from '../formDrafts';
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
  type GuardProblem,
  type MarkedClient,
} from '../guard';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
import type { SalonChoice } from './SalonsScreen';
import { SalonReadCache, useScreenLifetime } from './HistoryScreen';
const ruleFields = new Map<string, GuardProblem>([
  ['maxChanges', 'changes'],
  ['windowHours', 'windowDays'],
  ['lateCancelMinutes', 'lateMinutes'],
  ['maxNoShows', 'noShows'],
]);
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
  const draftKey = `guard.${salon.orgId}.${salon.locationId}`;
  const [releaseId, setReleaseId] = useFormDraft<string | null>(`${draftKey}.releaseId`, null);
  const [phase, setPhase] = useState<'saving' | 'refreshing' | null>(null);
  const pending = useRef<typeof phase>(null);
  const busy = phase !== null;
  const [edits, setEdits] = useFormDraft<Partial<GuardForm> | null>(`${draftKey}.rules`, null);
  const savedForm = settings && guardForm(settings);
  const form = savedForm && edits && { ...savedForm, ...edits };

  const [attemptedSave, setAttemptedSave] = useState(false);
  const checked = settings && form ? guardRulesToSave(settings, form) : null;
  const [serverProblem, setServerProblem] = useState<GuardProblem | null>(null);
  const dirty = form && JSON.stringify(savedForm) !== JSON.stringify(form);
  const problem = attemptedSave && checked && !checked.ok ? checked.problem : serverProblem;

  const lifetime = useScreenLifetime(salon);
  const load = useCallback(async () => {
    const signal = lifetime.current!.signal;
    if (signal.aborted) return;
    try {
      const [s, list] = await Promise.all([
        settingsCache.read(
          salon,
          () => api.guardSettings(salon.orgId, salon.locationId, signal),
          '',
          signal,
        ),
        clientsCache.read(
          salon,
          () => api.guardedClients(salon.orgId, salon.locationId, signal),
          '',
          signal,
        ),
      ]);
      if (signal.aborted) return;
      setSettings(s);
      setMarked(list);
    } catch (e) {
      if (!signal.aborted) setError(errorText(e, t));
    }
  }, [api, salon, t, lifetime]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = useCallback(() => {
    if (pending.current !== 'saving') onBack();
  }, [onBack]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      back();
      return true;
    });
    return () => sub.remove();
  }, [back]);

  async function run(action: (signal: AbortSignal) => Promise<void>, done: string, rules = false) {
    if (pending.current) return;
    const setPending = (next: typeof phase) => {
      pending.current = next;
      setPhase(next);
    };
    const refresh = () => {
      setPending('refreshing');
      return load();
    };
    setPending('saving');
    setError('');
    setInfo('');
    setServerProblem(null);
    const signal = lifetime.current!.signal;
    try {
      await action(signal);
      clientsCache.clear(salon);
      if (signal.aborted) return;
      await refresh();
      if (!signal.aborted) setInfo(done);
    } catch (e) {
      if (signal.aborted) return;
      setInfo('');
      if (e instanceof ApiError && e.status === 409) {
        settingsCache.clear(salon);
        clientsCache.clear(salon);
        setError(g.conflict);
        await refresh();
      } else {
        const field =
          rules &&
          e instanceof ApiError &&
          e.details.map(({ path }) => ruleFields.get(path)).find(Boolean);
        if (field) setServerProblem(field);
        else setError(errorText(e, t));
      }
    } finally {
      if (!signal.aborted) setPending(null);
    }
  }

  async function saveSettings(next: CancellationGuard, signal: AbortSignal) {
    const saved = await api.saveGuardSettings(salon.orgId, salon.locationId, next);
    settingsCache.set(salon, saved);
    if (!signal.aborted) setSettings(saved);
  }

  function switchTo(enabled: boolean) {
    if (!settings) return;
    if (enabled && !hasRule(settings)) return setError(g.needRule);
    void run(
      async (signal) => {
        await saveSettings(guardToSave(settings, enabled), signal);
        if (!signal.aborted) setAskOff(false);
      },
      enabled ? g.turnedOn : g.turnedOff,
    );
  }

  function changeRule<K extends keyof GuardForm>(key: K, value: GuardForm[K]) {
    if (serverProblem === key) setServerProblem(null);
    if (!savedForm) return;
    setEdits((current) => {
      const next = { ...current };
      if (savedForm[key] === value) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  function saveRules() {
    if (!checked) return;
    setAttemptedSave(true);
    if (!checked.ok) return;
    void run(
      async (signal) => {
        await saveSettings(checked.save, signal);
        setEdits(null);
      },
      g.rulesSaved,
      true,
    );
  }

  function release(customerId: string, note: string, clearNote: () => void) {
    void run(async () => {
      await api.releaseGuard(salon.orgId, salon.locationId, customerId, note);
      clearNote();
      setReleaseId(null);
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
            <Button kind="link" label={g.back} disabled={phase === 'saving'} onPress={back} />
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
              <Text role="status" style={styles.muted}>
                {t.loading}
              </Text>
            ) : (
              <Button
                label={t.day.refresh}
                onPress={() => {
                  setError('');
                  void load();
                }}
              />
            )
          ) : (
            <>
              <Card>
                <Text role="status" style={styles.name}>
                  {settings.enabled ? g.on : g.off}
                </Text>
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
                  <View role="group" accessibilityLabel={g.offAsk} style={{ gap: 8 }}>
                    <Text style={styles.text}>{g.offAsk}</Text>
                    <View style={styles.row}>
                      <Button label={g.offYes} busy={busy} onPress={() => switchTo(false)} />
                      <Button
                        kind="secondary"
                        disabled={busy}
                        label={g.no}
                        onPress={() => setAskOff(false)}
                      />
                    </View>
                  </View>
                ) : settings.enabled ? (
                  <Button
                    kind="secondary"
                    disabled={busy}
                    label={g.turnOff}
                    onPress={() => setAskOff(true)}
                  />
                ) : (
                  <Button label={g.turnOn} busy={busy} onPress={() => switchTo(true)} />
                )}
                {!form ? (
                  <Button
                    kind="secondary"
                    disabled={busy}
                    label={g.rulesChange}
                    onPress={() => {
                      setServerProblem(null);
                      setAttemptedSave(false);
                      setEdits({});
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
                    disabled={busy}
                    label={g.changesOn}
                    on={form.changesOn}
                    onPress={() => changeRule('changesOn', !form.changesOn)}
                  />
                  {form.changesOn ? (
                    <View style={styles.pair}>
                      <Field
                        disabled={busy}
                        paired
                        label={g.changes}
                        value={form.changes}
                        error={problem === 'changes' ? g.problem.changes : undefined}
                        onChange={(value) => changeRule('changes', value)}
                      />
                      <Field
                        disabled={busy}
                        paired
                        label={g.windowDays}
                        value={form.windowDays}
                        error={problem === 'windowDays' ? g.problem.windowDays : undefined}
                        onChange={(value) => changeRule('windowDays', value)}
                      />
                    </View>
                  ) : null}
                  <Toggle
                    disabled={busy}
                    label={g.lateOn}
                    on={form.lateOn}
                    onPress={() => changeRule('lateOn', !form.lateOn)}
                  />
                  {form.lateOn ? (
                    <Field
                      disabled={busy}
                      label={g.lateMinutes}
                      value={form.lateMinutes}
                      error={problem === 'lateMinutes' ? g.problem.lateMinutes : undefined}
                      onChange={(value) => changeRule('lateMinutes', value)}
                    />
                  ) : null}
                  <Toggle
                    disabled={busy}
                    label={g.noShowsOn}
                    on={form.noShowsOn}
                    onPress={() => changeRule('noShowsOn', !form.noShowsOn)}
                  />
                  {form.noShowsOn ? (
                    <Field
                      disabled={busy}
                      label={g.noShows}
                      value={form.noShows}
                      error={problem === 'noShows' ? g.problem.noShows : undefined}
                      onChange={(value) => changeRule('noShows', value)}
                    />
                  ) : null}
                  {problem === 'needRule' ? <ErrorText>! {g.problem.needRule}</ErrorText> : null}
                  <Text style={styles.label}>{g.actionLabel}</Text>
                  <View role="radiogroup" accessibilityLabel={g.actionLabel} style={{ gap: 8 }}>
                    {GUARD_ACTIONS.map((action) => (
                      <Pressable
                        accessibilityLabel={g.actions[action]}
                        disabled={busy}
                        key={action}
                        role="radio"
                        aria-checked={form.action === action}
                        accessibilityState={{ checked: form.action === action, disabled: busy }}
                        onPress={() => changeRule('action', action)}
                        style={[styles.choice, form.action === action && styles.choiceOn]}
                      >
                        <Text style={[styles.text, form.action === action && { color: '#fff' }]}>
                          {g.actions[action]}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  {dirty ? (
                    <Text role="status" style={styles.label}>
                      {t.navigation.unsaved}
                    </Text>
                  ) : null}
                  <View style={styles.row}>
                    <Button label={g.rulesSave} busy={busy} onPress={saveRules} />
                    <Button
                      kind="secondary"
                      disabled={busy}
                      label={g.cancel}
                      onPress={() => setEdits(null)}
                    />
                  </View>
                </Card>
              ) : null}

              <Text style={styles.section} role="heading">
                {g.clients}
              </Text>
            </>
          )}
        </View>
      }
      ListEmptyComponent={
        settings && marked ? (
          <Text style={styles.muted}>{settings.enabled ? g.none : g.offList}</Text>
        ) : undefined
      }
      renderItem={({ item: client }) => (
        <Card>
          <ClientDetails client={client} currency={marked!.currency} locale={props.locale} t={t} />
          {releaseId === client.customerId ? (
            <ReleaseForm
              draftKey={`${draftKey}.client.${client.customerId}.note`}
              label={fill(g.releaseOne, { name: client.name })}
              g={g}
              busy={busy}
              onRelease={(note, clearNote) => release(client.customerId, note, clearNote)}
              onCancel={() => setReleaseId(null)}
            />
          ) : (
            <Button
              kind="link"
              disabled={busy}
              label={g.release}
              a11yLabel={fill(g.releaseOne, { name: client.name })}
              onPress={() => setReleaseId(client.customerId)}
            />
          )}
        </Card>
      )}
    />
  );
}

function ReleaseForm(props: {
  draftKey: string;
  label: string;
  g: Dictionary['guard'];
  busy: boolean;
  onRelease: (note: string, clearNote: () => void) => void;
  onCancel: () => void;
}) {
  const { g, busy } = props;
  const [note, setNote] = useFormDraft(props.draftKey, '');
  return (
    <View role="group" accessibilityLabel={props.label} style={{ gap: 8 }}>
      <Text style={styles.text}>{g.releaseAsk}</Text>
      <TextInput
        accessibilityLabel={g.note}
        editable={!busy}
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
          onPress={() => props.onRelease(note, () => setNote(''))}
        />
        <Button
          kind="secondary"
          disabled={busy}
          label={g.no}
          onPress={() => {
            setNote('');
            props.onCancel();
          }}
        />
      </View>
    </View>
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

function Toggle(props: { disabled: boolean; label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      disabled={props.disabled}
      role="checkbox"
      aria-checked={props.on}
      accessibilityState={{ checked: props.on, disabled: props.disabled }}
      onPress={props.onPress}
      style={styles.toggle}
    >
      <View aria-hidden style={[styles.box, props.on && styles.boxOn]}>
        {props.on ? <Text style={{ color: '#fff', fontWeight: '700' }}>✓</Text> : null}
      </View>
      <Text style={[styles.text, styles.toggleLabel]}>{props.label}</Text>
    </Pressable>
  );
}

function Field(props: {
  disabled: boolean;
  label: string;
  value: string;
  paired?: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  const errorId = useId();
  return (
    <View style={[styles.field, props.paired && styles.pairedField]}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        editable={!props.disabled}
        accessibilityHint={props.error}
        aria-invalid={Boolean(props.error)}
        aria-describedby={props.error ? errorId : undefined}
        value={props.value}
        onChangeText={props.onChange}
        keyboardType="number-pad"
        style={[styles.input, props.error && styles.invalid]}
      />
      {props.error ? (
        <View nativeID={errorId}>
          <ErrorText>! {props.error}</ErrorText>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  field: { gap: 4, minWidth: 0 },
  pairedField: { flexBasis: 140, flexGrow: 1 },
  toggleLabel: { flexShrink: 1 },
  toggle: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 6 },
  box: {
    width: 24,
    minHeight: 24,
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
  invalid: { borderColor: colors.danger },
  input: {
    minHeight: 44,
    minWidth: 44,
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
