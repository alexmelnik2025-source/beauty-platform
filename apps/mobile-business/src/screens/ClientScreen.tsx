import { useCallback, useEffect, useState } from 'react';
import {
  BackHandler,
  Linking,
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
  type CustomerDetail,
  type GuardedClient,
  type Locale,
  type LoyaltyAccount,
} from '../api';
import {
  birthdayText,
  bonusSummary,
  canEditNotes,
  completedCount,
  dateIn,
  addTag,
  parseTags,
  splitVisits,
  suggestTags,
  visitWhen,
  type ClientVisit,
} from '../clients';
import { formatPrice } from '../day';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * One client: contacts (call / SMS), tags, note, marketing consent and the visits in this salon.
 * What is visible is decided by the server: a specialist gets only their own clients and visits,
 * contacts and notes only with the permission (the fields come as null).
 */
export function ClientScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  id: string;
  timeZone: string;
  onBack: () => void;
}) {
  const { api, t, salon, id, onBack } = props;
  const c = t.clients;
  const [client, setClient] = useState<CustomerDetail | null>(null);
  const [mayEdit, setMayEdit] = useState(salon.role !== 'staff');
  const [ownOnly, setOwnOnly] = useState(false);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  /** Task 226: the salon's labels, offered while editing (owners and managers). */
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<LoyaltyAccount | null>(null);
  /** Task 161c: the cancellation-protection mark (owners and managers). */
  const [guard, setGuard] = useState<GuardedClient | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [releaseNote, setReleaseNote] = useState('');

  const load = useCallback(async () => {
    try {
      setClient(await api.customer(salon.orgId, id));
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, id, t]);

  useEffect(() => {
    void load();
    let alive = true;
    // Owners and managers: stamps or points, tier and coupons (the server refuses specialists).
    if (salon.role !== 'staff') {
      void api.loyaltyAccount(salon.orgId, id).then(
        (a) => alive && setAccount(a),
        () => undefined,
      );
      void api.guardClient(salon.orgId, salon.locationId, id).then(
        (g) => alive && setGuard(g),
        () => undefined,
      );
      void api.customerTags(salon.orgId).then(
        (r) => alive && setKnownTags(r.tags.map((item) => item.tag)),
        () => undefined,
      );
    }
    void api.permissions(salon.orgId).then(
      ({ me }) => {
        if (!alive) return;
        setMayEdit(canEditNotes(me));
        setOwnOnly(me.role === 'staff' && !me.permissions.viewClientHistory);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, salon, id, load]);

  // Android "back" closes the card instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  function startEditing(current: CustomerDetail) {
    setNote(current.note ?? '');
    setTags((current.tags ?? []).join(', '));
    setInfo('');
    setEditing(true);
  }

  async function save() {
    if (!client) return;
    setBusy(true);
    setError('');
    try {
      const text = note.trim();
      setClient(
        await api.updateCustomerNotes(
          salon.orgId,
          client.id,
          client.version,
          text ? text : null,
          parseTags(tags),
        ),
      );
      setEditing(false);
      setInfo(c.saved);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setError(c.conflict);
        setEditing(false);
        await load();
      } else {
        setError(errorText(e, t));
      }
    } finally {
      setBusy(false);
    }
  }

  const back = <Button kind="link" label={c.back} onPress={onBack} />;
  async function releaseGuard() {
    setBusy(true);
    setError('');
    try {
      setGuard(await api.releaseGuard(salon.orgId, salon.locationId, id, releaseNote));
      setReleasing(false);
      setReleaseNote('');
      setInfo(c.guard.released);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  if (!client) {
    return (
      <View style={styles.screen}>
        <View style={styles.row}>{back}</View>
        {error ? <ErrorText>{error}</ErrorText> : <Text style={styles.muted}>{t.loading}</Text>}
      </View>
    );
  }

  const { upcoming, past } = splitVisits(client.visits, salon.locationId);
  const bonus = account ? bonusSummary(account) : null;
  const notesVisible = client.note !== null || client.tags !== null;
  const visitRow = (v: ClientVisit) => (
    <View key={v.id} style={styles.visit}>
      <View style={styles.visitTop}>
        <Text style={styles.value}>{visitWhen(v.start, props.timeZone, props.locale)}</Text>
        <Text style={[styles.chip, v.status === 'no_show' && styles.chipBad]}>
          {c.status[v.status]}
        </Text>
      </View>
      <Text style={styles.muted}>
        {v.serviceName} · {v.staffName}
      </Text>
    </View>
  );

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.row}>{back}</View>
      <Heading>{client.name}</Heading>
      <View style={styles.chips}>
        <Text style={styles.chip}>
          {fill(c.completed, {
            count: String(completedCount(client.visits, salon.locationId)),
          })}
        </Text>
        {/* Task 98: the server's summary over every visit the user may see. */}
        {client.summary.noShow > 0 ? (
          <Text style={[styles.chip, styles.chipBad]}>
            {fill(c.noShows, { count: String(client.summary.noShow) })}
          </Text>
        ) : null}
        {client.summary.cancelledByClient > 0 ? (
          <Text style={styles.chip}>
            {fill(c.cancelledByClient, { count: String(client.summary.cancelledByClient) })}
          </Text>
        ) : null}
        {client.summary.paid && client.summary.paid.length > 0 ? (
          <Text style={styles.chip}>
            {fill(c.paid, {
              amount: client.summary.paid
                .map((p) => formatPrice(p.amountGrosze, p.currency, props.locale))
                .join(' + '),
            })}
          </Text>
        ) : null}
        {(client.tags ?? []).map((tag) => (
          <Text key={tag} style={[styles.chip, styles.tag]}>
            {tag}
          </Text>
        ))}
      </View>

      {error ? <ErrorText>{error}</ErrorText> : null}
      {info ? <Text style={styles.info}>{info}</Text> : null}

      <Card>
        <Text style={styles.label}>{c.contacts}</Text>
        {client.phone ? (
          <View style={styles.row}>
            <Button
              kind="secondary"
              label={`${t.visit.call} ${client.phone}`}
              onPress={() => void Linking.openURL(`tel:${client.phone}`)}
            />
            <Button
              kind="secondary"
              label={t.visit.sms}
              onPress={() => void Linking.openURL(`sms:${client.phone}`)}
            />
          </View>
        ) : null}
        {client.email ? <Text style={styles.value}>{client.email}</Text> : null}
        {client.birthday ? (
          <Text style={styles.value}>
            🎂 {c.birthday}:{' '}
            {birthdayText(client.birthday, props.locale, c.birthdayToday, props.timeZone)}
          </Text>
        ) : null}
        {!client.phone && !client.email ? (
          <Text style={styles.muted}>{c.contactsHidden}</Text>
        ) : null}
        {client.marketingConsent !== null ? (
          <Text style={styles.muted}>
            {c.marketing}: {client.marketingConsent ? c.yes : c.no}
          </Text>
        ) : null}

        <Text style={styles.label}>{c.note}</Text>
        {!notesVisible ? (
          <Text style={styles.muted}>{c.notesHidden}</Text>
        ) : editing ? (
          <View style={styles.form}>
            <TextInput
              accessibilityLabel={c.note}
              value={note}
              onChangeText={setNote}
              multiline
              maxLength={1000}
              style={[styles.input, styles.noteInput]}
            />
            <Text style={styles.small}>{c.tags}</Text>
            <TextInput
              accessibilityLabel={c.tags}
              placeholder={c.tagsHint}
              placeholderTextColor={colors.placeholder}
              value={tags}
              onChangeText={setTags}
              autoCapitalize="none"
              style={styles.input}
            />
            {suggestTags(tags, knownTags).length > 0 ? (
              <View style={styles.row}>
                {suggestTags(tags, knownTags).map((tag) => (
                  <Pressable
                    key={tag}
                    accessibilityRole="button"
                    accessibilityLabel={`${c.addTag} ${tag}`}
                    onPress={() => setTags(addTag(tags, tag))}
                    style={styles.tagChip}
                  >
                    <Text style={styles.tagChipText}>+ {tag}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <View style={styles.row}>
              <Button label={c.save} busy={busy} onPress={() => void save()} />
              <Button
                kind="secondary"
                label={c.cancel}
                disabled={busy}
                onPress={() => setEditing(false)}
              />
            </View>
          </View>
        ) : (
          <>
            <Text style={client.note ? styles.value : styles.muted}>{client.note ?? c.noNote}</Text>
            {mayEdit ? (
              <View style={styles.row}>
                <Button kind="secondary" label={c.edit} onPress={() => startEditing(client)} />
              </View>
            ) : null}
          </>
        )}
      </Card>

      {bonus ? (
        <Card>
          <Text style={styles.label}>{c.bonuses}</Text>
          <Text style={styles.value}>
            {fill(bonus.mode === 'stamps' ? c.stamps : c.points, { count: String(bonus.balance) })}
          </Text>
          {bonus.tier ? (
            <Text style={styles.value}>{fill(c.tier, { tier: bonus.tier })}</Text>
          ) : null}
          {bonus.coupons.length > 0 ? (
            <>
              <Text style={styles.label}>{c.coupons}</Text>
              {bonus.coupons.map((coupon) => (
                <Text key={coupon.id} style={styles.value}>
                  {coupon.name} · {coupon.code}
                  {coupon.expiresAt ? (
                    <Text style={styles.muted}>
                      {' '}
                      ·{' '}
                      {fill(c.until, {
                        date: dateIn(coupon.expiresAt, props.timeZone, props.locale),
                      })}
                    </Text>
                  ) : null}
                </Text>
              ))}
            </>
          ) : null}
        </Card>
      ) : null}

      {guard && (guard.enabled || guard.history.length > 0) ? (
        <Card>
          <Text style={styles.label}>{c.guard.title}</Text>
          {guard.flagged ? (
            <>
              <Text style={styles.value}>{c.guard.marked}</Text>
              <Text style={styles.small}>
                {[
                  guard.reasons.includes('changes') &&
                    fill(c.guard.reasonChanges, { n: String(guard.changes) }),
                  guard.reasons.includes('late_cancel') &&
                    fill(c.guard.reasonLate, { n: String(guard.lateCancellations) }),
                  guard.reasons.includes('no_shows') &&
                    fill(c.guard.reasonNoShows, { n: String(guard.noShows) }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {guard.noShowAmountGrosze > 0 ? (
                <Text style={styles.value}>
                  {fill(c.guard.owes, {
                    sum: formatPrice(guard.noShowAmountGrosze, guard.currency, props.locale),
                  })}
                </Text>
              ) : null}
              {releasing ? (
                <View style={styles.form}>
                  <Text style={styles.muted}>{c.guard.releaseAsk}</Text>
                  <TextInput
                    accessibilityLabel={c.guard.note}
                    placeholder={c.guard.note}
                    value={releaseNote}
                    maxLength={300}
                    onChangeText={setReleaseNote}
                    style={styles.input}
                  />
                  <View style={styles.row}>
                    <Button
                      label={c.guard.releaseYes}
                      busy={busy}
                      onPress={() => void releaseGuard()}
                    />
                    <Button
                      kind="secondary"
                      label={c.guard.no}
                      onPress={() => setReleasing(false)}
                    />
                  </View>
                </View>
              ) : (
                <View style={styles.row}>
                  <Button
                    kind="secondary"
                    label={c.guard.release}
                    onPress={() => {
                      setInfo('');
                      setReleasing(true);
                    }}
                  />
                </View>
              )}
            </>
          ) : (
            <Text style={styles.muted}>{guard.enabled ? c.guard.notMarked : c.guard.off}</Text>
          )}
          {guard.history.slice(0, 5).map((h, i) => (
            <Text key={i} style={styles.small}>
              {dateIn(h.at, props.timeZone, props.locale)} · {c.guard.history[h.type]}
              {h.late ? ` · ${c.guard.late}` : ''}
              {h.note ? ` · ${h.note}` : ''}
            </Text>
          ))}
        </Card>
      ) : null}

      {ownOnly ? <Text style={styles.muted}>{c.ownOnly}</Text> : null}
      {upcoming.length > 0 ? (
        <>
          <Text style={styles.section}>{c.upcoming}</Text>
          <Card>{upcoming.map(visitRow)}</Card>
        </>
      ) : null}
      <Text style={styles.section}>{c.history}</Text>
      {past.length === 0 ? (
        <Text style={styles.muted}>{c.noVisits}</Text>
      ) : (
        <Card>{past.map(visitRow)}</Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  tagChip: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  tagChipText: { color: colors.ink, fontSize: 14 },
  chips: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  chip: {
    fontSize: 12,
    color: colors.ink,
    backgroundColor: colors.soft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
  tag: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.accent },
  chipBad: { backgroundColor: '#f6dcd9', color: colors.danger },
  label: { marginTop: 8, fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  section: { marginTop: 8, fontSize: 13, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  value: { fontSize: 17, color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  info: { color: '#2e7d32', fontSize: 15 },
  form: { gap: 8 },
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
  noteInput: { minHeight: 90, textAlignVertical: 'top' },
  visit: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    gap: 2,
  },
  visitTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
