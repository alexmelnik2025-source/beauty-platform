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
import {
  ApiError,
  type BusinessApi,
  type Locale,
  type LoyaltyProgram,
  type LoyaltyReward,
  type LoyaltyTransaction,
} from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  costText,
  operationLine,
  operationTitle,
  programRule,
  programToSave,
  rewardLabel,
  rulesForm,
  rulesToSave,
  sortedRewards,
  type RulesForm,
} from '../loyalty';
import { formatPrice } from '../day';
import {
  EMPTY_REWARD_FULL,
  rewardForm,
  rewardLimits,
  rewardToSave,
  rewardUpdate,
  toggledService,
  type RewardFormFull,
} from '../rewardEdit';
import { BonusRulesSection } from './BonusRulesSection';
import { EarnRulesSection } from './EarnRulesSection';
import { TiersSection } from './TiersSection';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 206: "Program lojalnościowy" — the owner or a manager switches the program on or off,
 * adds a reward (a discount in % or a free service for N stamps or points), removes one and sees
 * the latest operations. Task 344: "Zasady programu" — stamps or points, how much a visit earns,
 * the minimum amount, how long points last, the maximum discount and combining discounts. Tasks
 * 345–347: tiers, extra stamps and points, and stamps or points per service.
 */
export function LoyaltyScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  timeZone: string;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const l = t.loyalty;
  const [program, setProgram] = useState<LoyaltyProgram | null>(null);
  const [rewards, setRewards] = useState<LoyaltyReward[]>([]);
  const [operations, setOperations] = useState<LoyaltyTransaction[]>([]);
  const [services, setServices] = useState<{ id: string; name: string }[]>([]);
  const [serviceNames, setServiceNames] = useState(new Map<string, string>());
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [askOff, setAskOff] = useState(false);
  const [form, setForm] = useState<RewardFormFull | null>(null);
  /** Task 348: the reward being changed (null = the form adds a new one). */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [rules, setRules] = useState<RulesForm | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, r, ops, list] = await Promise.all([
        api.loyaltyProgram(salon.orgId),
        api.loyaltyRewards(salon.orgId),
        api.loyaltyTransactions(salon.orgId, 20),
        api.services(salon.orgId, salon.locationId),
      ]);
      setProgram(p);
      setRewards(sortedRewards(r));
      setOperations(ops);
      setServiceNames(new Map(list.map((s) => [s.id, s.name])));
      setServices(list.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name })));
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
      setInfo(done);
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setInfo('');
        setError(l.conflict);
        await load();
      } else {
        setError(errorText(e, t));
      }
    } finally {
      setBusy(false);
    }
  }

  function switchTo(enabled: boolean) {
    if (!program) return;
    setAskOff(false);
    void run(
      async () =>
        setProgram(await api.saveLoyaltyProgram(salon.orgId, programToSave(program, enabled))),
      enabled ? l.turnedOn : l.turnedOff,
    );
  }

  function saveRules() {
    if (!program || !rules) return;
    const checked = rulesToSave(program, rules);
    if (!checked.ok) return setError(l.rulesProblem[checked.problem]);
    void run(async () => {
      setProgram(await api.saveLoyaltyProgram(salon.orgId, checked.save));
      setRules(null);
    }, l.rulesSaved);
  }

  function closeForm() {
    setForm(null);
    setEditingId(null);
  }

  /** Adds a reward, or with "Zmień" saves the changed one (task 348). */
  function saveReward() {
    if (!form) return;
    const checked = rewardToSave(form);
    if (!checked.ok) return setError(l.problem[checked.problem]);
    const saved = editingId ? rewards.find((r) => r.id === editingId) : undefined;
    setBusy(true);
    void (async () => {
      try {
        if (saved) {
          await api.updateLoyaltyReward(salon.orgId, saved.id, rewardUpdate(saved, checked.reward));
        } else {
          await api.addLoyaltyReward(salon.orgId, checked.reward);
        }
        closeForm();
        setInfo(saved ? l.updated : l.added);
        setError('');
        await load();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setInfo('');
          setError(l.rewardConflict);
          closeForm();
          await load();
        } else {
          setError(errorText(e, t));
        }
      } finally {
        setBusy(false);
      }
    })();
  }

  /** "kupon ważny 30 dni · tylko: Broda" or null. */
  const limitsOf = (reward: LoyaltyReward) => rewardLimits(reward, serviceNames, l, fill);

  function remove(id: string) {
    setRemoveId(null);
    void run(async () => {
      await api.removeLoyaltyReward(salon.orgId, id);
      await load();
    }, l.removed);
  }

  const mode = program?.mode ?? 'stamps';

  const editor = form ? (
    <Card>
      <TextInput
        accessibilityLabel={l.name}
        placeholder={l.name}
        placeholderTextColor={colors.placeholder}
        value={form.name}
        onChangeText={(name) => setForm({ ...form, name })}
        style={styles.input}
      />
      <View style={styles.row}>
        <Chip
          label={l.kindDiscount}
          on={form.kind === 'discount_percent'}
          onPress={() => setForm({ ...form, kind: 'discount_percent' })}
        />
        <Chip
          label={l.kindFree}
          on={form.kind === 'free_service'}
          onPress={() => setForm({ ...form, kind: 'free_service' })}
        />
      </View>
      {form.kind === 'discount_percent' ? (
        <TextInput
          accessibilityLabel={l.percent}
          placeholder={l.percent}
          placeholderTextColor={colors.placeholder}
          value={form.percent}
          onChangeText={(percent) => setForm({ ...form, percent })}
          keyboardType="number-pad"
          style={styles.input}
        />
      ) : (
        <>
          <Text style={styles.label}>{l.service}</Text>
          {services.length === 0 ? (
            <Text style={styles.muted}>{l.noServices}</Text>
          ) : (
            <View style={styles.row}>
              {services.map((s) => (
                <Chip
                  key={s.id}
                  label={s.name}
                  on={form.serviceId === s.id}
                  onPress={() => setForm({ ...form, serviceId: s.id })}
                />
              ))}
            </View>
          )}
        </>
      )}
      <TextInput
        accessibilityLabel={mode === 'stamps' ? l.costStamps : l.costPoints}
        placeholder={mode === 'stamps' ? l.costStamps : l.costPoints}
        placeholderTextColor={colors.placeholder}
        value={form.cost}
        onChangeText={(cost) => setForm({ ...form, cost })}
        keyboardType="number-pad"
        style={styles.input}
      />
      <TextInput
        accessibilityLabel={l.couponValidityDays}
        placeholder={l.couponValidityDays}
        placeholderTextColor={colors.placeholder}
        value={form.validityDays}
        onChangeText={(validityDays) => setForm({ ...form, validityDays })}
        keyboardType="number-pad"
        style={styles.input}
      />
      {services.length > 0 ? (
        <>
          <Text style={styles.label}>{l.onlyServices}</Text>
          <View style={styles.row}>
            {services.map((s) => (
              <Chip
                key={s.id}
                label={s.name}
                a11yLabel={fill(l.onlyOne, { service: s.name })}
                on={form.serviceIds.includes(s.id)}
                onPress={() =>
                  setForm({ ...form, serviceIds: toggledService(form.serviceIds, s.id) })
                }
              />
            ))}
          </View>
        </>
      ) : null}
      <View style={styles.row}>
        <Button label={l.save} busy={busy} onPress={saveReward} />
        <Button kind="secondary" label={l.cancel} onPress={closeForm} />
      </View>
    </Card>
  ) : null;

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={l.back} onPress={onBack} />
      </View>
      <Heading>{l.title}</Heading>
      <Text style={styles.muted}>{l.hint}</Text>
      {info ? (
        <Text role="status" style={styles.info}>
          {info}
        </Text>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}

      {program === null ? (
        !error ? (
          <Text style={styles.muted}>{t.loading}</Text>
        ) : null
      ) : (
        <>
          <Card>
            <Text style={styles.name}>{program.enabled ? l.on : l.off}</Text>
            <Text style={styles.text}>{programRule(program, t, props.locale, salon.currency)}</Text>
            {!program.enabled ? <Text style={styles.muted}>{l.offHint}</Text> : null}
            {askOff ? (
              <View style={{ gap: 8 }}>
                <Text style={styles.text}>{l.offAsk}</Text>
                <View style={styles.row}>
                  <Button label={l.offYes} busy={busy} onPress={() => switchTo(false)} />
                  <Button kind="secondary" label={l.no} onPress={() => setAskOff(false)} />
                </View>
              </View>
            ) : program.enabled ? (
              <Button kind="secondary" label={l.turnOff} onPress={() => setAskOff(true)} />
            ) : (
              <Button label={l.turnOn} busy={busy} onPress={() => switchTo(true)} />
            )}
          </Card>

          <Text style={styles.section} role="heading">
            {l.rules}
          </Text>
          {rules ? (
            <Card>
              <View style={styles.row}>
                <Chip
                  label={l.modeStamps}
                  on={rules.mode === 'stamps'}
                  onPress={() => setRules({ ...rules, mode: 'stamps' })}
                />
                <Chip
                  label={l.modePoints}
                  on={rules.mode === 'points'}
                  onPress={() => setRules({ ...rules, mode: 'points' })}
                />
              </View>
              <Text style={styles.muted}>
                {rules.mode === 'stamps' ? l.stampsHint : l.pointsHint}
              </Text>
              {rules.mode === 'stamps' ? (
                <Field
                  label={l.stampsPerVisit}
                  value={rules.stampsPerVisit}
                  onChange={(stampsPerVisit) => setRules({ ...rules, stampsPerVisit })}
                />
              ) : (
                <>
                  <Field
                    label={l.pointsPerUnit}
                    value={rules.pointsPerUnit}
                    onChange={(pointsPerUnit) => setRules({ ...rules, pointsPerUnit })}
                  />
                  <Field
                    label={fill(l.spendUnit, { currency: salon.currency })}
                    value={rules.spendUnit}
                    decimal
                    onChange={(spendUnit) => setRules({ ...rules, spendUnit })}
                  />
                  <Field
                    label={l.validityDays}
                    value={rules.validityDays}
                    onChange={(validityDays) => setRules({ ...rules, validityDays })}
                  />
                </>
              )}
              <Field
                label={fill(l.minSpend, { currency: salon.currency })}
                value={rules.minSpend}
                decimal
                onChange={(minSpend) => setRules({ ...rules, minSpend })}
              />
              <Field
                label={l.maxDiscount}
                value={rules.maxDiscountPercent}
                onChange={(maxDiscountPercent) => setRules({ ...rules, maxDiscountPercent })}
              />
              <View style={styles.row}>
                <Chip
                  label={l.noStacking}
                  on={!rules.allowStacking}
                  onPress={() => setRules({ ...rules, allowStacking: false })}
                />
                <Chip
                  label={l.stacking}
                  on={rules.allowStacking}
                  onPress={() => setRules({ ...rules, allowStacking: true })}
                />
              </View>
              <View style={styles.row}>
                <Button label={l.rulesSave} busy={busy} onPress={saveRules} />
                <Button kind="secondary" label={l.cancel} onPress={() => setRules(null)} />
              </View>
            </Card>
          ) : (
            <Card>
              <Text style={styles.muted}>
                {[
                  program.minSpendGrosze > 0
                    ? fill(l.minSpendRule, {
                        amount: formatPrice(program.minSpendGrosze, salon.currency, props.locale),
                      })
                    : null,
                  program.mode === 'points' && program.pointsValidityDays !== null
                    ? fill(l.validityRule, { days: String(program.pointsValidityDays) })
                    : null,
                  fill(l.maxDiscountRule, { percent: String(program.maxDiscountPercent) }),
                  program.allowStacking ? l.stacking : l.noStacking,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              <Button
                kind="secondary"
                label={l.rulesChange}
                onPress={() => {
                  setRules(rulesForm(program));
                  setInfo('');
                  setError('');
                }}
              />
            </Card>
          )}

          <Text style={styles.section} role="heading">
            {l.earn}
          </Text>
          <EarnRulesSection
            api={api}
            t={t}
            salon={salon}
            program={program}
            services={services}
            onSaved={setProgram}
          />

          <Text style={styles.section} role="heading">
            {l.tiers}
          </Text>
          <TiersSection api={api} t={t} locale={props.locale} salon={salon} />

          <Text style={styles.section} role="heading">
            {l.bonusRules}
          </Text>
          <BonusRulesSection api={api} t={t} locale={props.locale} salon={salon} />

          <Text style={styles.section} role="heading">
            {l.rewards}
          </Text>
          <Text style={styles.muted}>{l.rewardsHint}</Text>
          {form && editingId === null ? (
            editor
          ) : (
            <Button
              kind="secondary"
              label={l.add}
              onPress={() => {
                setEditingId(null);
                setForm(EMPTY_REWARD_FULL);
                setInfo('');
                setError('');
              }}
            />
          )}
          {rewards.length === 0 ? (
            <Text style={styles.muted}>{l.noRewards}</Text>
          ) : (
            rewards.map((reward) =>
              editingId === reward.id && editor ? (
                <View key={reward.id}>{editor}</View>
              ) : (
                <Card key={reward.id}>
                  <Text style={styles.name}>{reward.name}</Text>
                  <Text style={styles.text}>
                    {`${rewardLabel(reward, serviceNames, t)} · ${costText(reward.cost, mode, t)}`}
                  </Text>
                  {limitsOf(reward) ? <Text style={styles.muted}>{limitsOf(reward)}</Text> : null}
                  {removeId === reward.id ? (
                    <View style={{ gap: 8 }}>
                      <Text style={styles.text}>{l.removeAsk}</Text>
                      <View style={styles.row}>
                        <Button label={l.removeYes} busy={busy} onPress={() => remove(reward.id)} />
                        <Button kind="secondary" label={l.no} onPress={() => setRemoveId(null)} />
                      </View>
                    </View>
                  ) : (
                    <View style={styles.row}>
                      <Button
                        kind="link"
                        label={l.edit}
                        a11yLabel={fill(l.editOne, { name: reward.name })}
                        onPress={() => {
                          setRemoveId(null);
                          setEditingId(reward.id);
                          setForm(rewardForm(reward));
                          setInfo('');
                          setError('');
                        }}
                      />
                      <Button
                        kind="link"
                        label={l.remove}
                        a11yLabel={fill(l.removeOne, { name: reward.name })}
                        onPress={() => setRemoveId(reward.id)}
                      />
                    </View>
                  )}
                </Card>
              ),
            )
          )}

          <Text style={styles.section} role="heading">
            {l.history}
          </Text>
          {operations.length === 0 ? (
            <Text style={styles.muted}>{l.noHistory}</Text>
          ) : (
            operations.map((entry) => (
              <Card key={entry.id}>
                <Text style={styles.text}>{operationTitle(entry, t)}</Text>
                <Text style={styles.muted}>
                  {operationLine(entry, t, props.locale, props.timeZone)}
                </Text>
                {entry.note ? <Text style={styles.muted}>{entry.note}</Text> : null}
              </Card>
            ))
          )}
        </>
      )}
    </ScrollView>
  );
}

function Field(props: {
  label: string;
  value: string;
  decimal?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        keyboardType={props.decimal ? 'decimal-pad' : 'number-pad'}
        style={styles.input}
      />
    </View>
  );
}

function Chip(props: { label: string; on: boolean; onPress: () => void; a11yLabel?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.a11yLabel ?? props.label}
      aria-pressed={props.on}
      accessibilityState={{ selected: props.on }}
      onPress={props.onPress}
      style={[styles.chip, props.on && styles.chipOn]}
    >
      <Text style={[styles.chipText, props.on && { color: '#fff' }]}>{props.label}</Text>
    </Pressable>
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
  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 15, color: colors.ink },
});
