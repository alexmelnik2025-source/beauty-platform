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
import type { BusinessApi, Locale } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { dialForTimeZone } from '../phone';
import {
  inviteBody,
  inviteError,
  mayRemove,
  rolesToInvite,
  teamOf,
  type Member,
  type Team,
} from '../team';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import { PermissionsScreen } from './PermissionsScreen';
import type { SalonChoice } from './SalonsScreen';

/** Whom the open invitation form is for: a specialist profile without an account, or someone new. */
type Form = { staffMemberId: string | null; name: string | null };

/**
 * Task 92: "Zespół" — the owner gives access right from the phone (email + phone + role, the
 * person signs in with a code); sees who has access, who is invited, cancels invitations and
 * removes people. A manager invites specialists only; a specialist does not see this screen.
 * Task 330: "Uprawnienia" — what specialists with an account may do (PermissionsScreen).
 */
export function TeamScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  timeZone: string;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const z = t.team;
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<'staff' | 'manager'>('staff');
  const [busy, setBusy] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  /** Task 330: "Uprawnienia" is open. */
  const [rights, setRights] = useState(false);
  const roles = rolesToInvite(salon.role);

  const load = useCallback(async () => {
    try {
      const [staff, members, invitations] = await Promise.all([
        api.staff(salon.orgId, salon.locationId),
        api.members(salon.orgId),
        api.invitations(salon.orgId),
      ]);
      setTeam(teamOf(staff, members, invitations, salon.locationId));
      setError('');
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (rights) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack, rights]);

  function openForm(next: Form) {
    setForm(next);
    setEmail('');
    setPhone('');
    setRole('staff');
    setError('');
    setInfo('');
  }

  async function send() {
    if (!form) return;
    const checked = inviteBody(
      { email, phone },
      {
        role: form.staffMemberId ? 'staff' : role,
        locationId: salon.locationId,
        staffMemberId: form.staffMemberId,
        dial: dialForTimeZone(props.timeZone),
        locale: props.locale,
      },
    );
    if (!checked.ok) return setError(z.problem[checked.problem]);
    setBusy(true);
    try {
      await api.invite(salon.orgId, checked.body);
      setForm(null);
      setInfo(fill(z.sent, { email: checked.body.email }));
      setError('');
      await load();
    } catch (e) {
      const kind = inviteError(e);
      setError(kind === 'other' ? errorText(e, t) : z.problem[kind]);
    } finally {
      setBusy(false);
    }
  }

  async function act(run: () => Promise<void>, done: string) {
    setBusy(true);
    try {
      await run();
      setInfo(done);
      setError('');
      await load();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  function removeButtons(member: Member, name: string) {
    if (!mayRemove(salon.role, member)) return null;
    if (removeId !== member.membershipId) {
      return (
        <Button
          kind="link"
          label={z.remove}
          a11yLabel={`${z.remove}: ${name}`}
          onPress={() => setRemoveId(member.membershipId)}
        />
      );
    }
    return (
      <View style={{ gap: 8 }}>
        <Text style={styles.text}>{fill(z.removeConfirm, { name })}</Text>
        <View style={styles.row}>
          <Button
            label={z.yes}
            busy={busy}
            onPress={() => {
              setRemoveId(null);
              void act(() => api.removeMember(salon.orgId, member.membershipId), z.removed);
            }}
          />
          <Button kind="secondary" label={z.no} onPress={() => setRemoveId(null)} />
        </View>
      </View>
    );
  }

  const roleName = (r: 'owner' | 'manager' | 'staff') => z.roles[r];

  if (rights) {
    return (
      <PermissionsScreen
        api={api}
        t={t}
        salon={salon}
        onBack={() => {
          setRights(false);
          void load();
        }}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Button kind="link" label={z.back} onPress={onBack} />
      </View>
      <Heading>{z.title}</Heading>
      <View style={styles.row}>
        <Button
          kind="secondary"
          label={t.rights.open}
          onPress={() => {
            setInfo('');
            setRights(true);
          }}
        />
      </View>
      {info ? (
        <Text role="status" style={styles.info}>
          {info}
        </Text>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}

      {form ? (
        <Card>
          <Text role="heading" aria-level={2} style={styles.section}>
            {form.name ? fill(z.inviteFor, { name: form.name }) : z.inviteTitle}
          </Text>
          <TextInput
            accessibilityLabel={z.email}
            placeholder={z.email}
            placeholderTextColor={colors.placeholder}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            style={styles.input}
          />
          <TextInput
            accessibilityLabel={z.phone}
            placeholder={`${z.phone} (+${dialForTimeZone(props.timeZone)})`}
            placeholderTextColor={colors.placeholder}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            style={styles.input}
          />
          {!form.staffMemberId && roles.length > 1 ? (
            <View style={styles.row} accessibilityLabel={z.role}>
              <Text style={styles.muted}>{z.role}:</Text>
              {roles.map((r) => (
                <Pressable
                  key={r}
                  accessibilityRole="button"
                  aria-pressed={role === r}
                  accessibilityState={{ selected: role === r }}
                  onPress={() => setRole(r)}
                  style={[styles.chip, role === r && styles.chipOn]}
                >
                  <Text style={[styles.chipText, role === r && { color: '#fff' }]}>
                    {roleName(r)}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <Text style={styles.muted}>{z.hint}</Text>
          <View style={styles.row}>
            <Button label={z.send} busy={busy} onPress={() => void send()} />
            <Button kind="secondary" label={z.cancel} onPress={() => setForm(null)} />
          </View>
        </Card>
      ) : roles.length > 0 ? (
        <Button
          kind="secondary"
          label={z.newPerson}
          onPress={() => openForm({ staffMemberId: null, name: null })}
        />
      ) : null}

      {team === null ? (
        !error ? (
          <Text style={styles.muted}>{t.loading}</Text>
        ) : null
      ) : (
        <>
          <Text role="heading" aria-level={2} style={styles.section}>
            {z.specialists}
          </Text>
          {team.specialists.length === 0 ? <Text style={styles.muted}>{z.none}</Text> : null}
          {team.specialists.map((row) => (
            <Card key={row.staff.id}>
              <Text style={styles.name}>{row.staff.displayName}</Text>
              {row.state === 'account' ? (
                <>
                  <Text style={styles.ok}>
                    {row.member ? `${z.hasAccount} · ${row.member.user.email}` : z.hasAccount}
                  </Text>
                  {row.member ? removeButtons(row.member, row.staff.displayName) : null}
                </>
              ) : row.state === 'invited' ? (
                <>
                  <Text style={styles.waiting}>
                    {[z.invited, row.invitation.email, row.invitation.phone]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                  <Button
                    kind="link"
                    label={z.cancelInvitation}
                    a11yLabel={`${z.cancelInvitation}: ${row.staff.displayName}`}
                    onPress={() =>
                      void act(
                        () => api.cancelInvitation(salon.orgId, row.invitation.id),
                        z.cancelled,
                      )
                    }
                  />
                </>
              ) : (
                <>
                  <Text style={styles.muted}>{z.noAccount}</Text>
                  {roles.includes('staff') ? (
                    <Button
                      kind="link"
                      label={z.invite}
                      a11yLabel={`${z.invite}: ${row.staff.displayName}`}
                      onPress={() =>
                        openForm({ staffMemberId: row.staff.id, name: row.staff.displayName })
                      }
                    />
                  ) : null}
                </>
              )}
            </Card>
          ))}

          <Text role="heading" aria-level={2} style={styles.section}>
            {z.managers}
          </Text>
          {team.managers.map((m) => (
            <Card key={m.membershipId}>
              <Text style={styles.name}>{m.user.name}</Text>
              <Text style={styles.muted}>{`${roleName(m.role)} · ${m.user.email}`}</Text>
              {removeButtons(m, m.user.name)}
            </Card>
          ))}

          {team.invitations.length > 0 ? (
            <>
              <Text role="heading" aria-level={2} style={styles.section}>
                {z.invitations}
              </Text>
              {team.invitations.map((i) => (
                <Card key={i.id}>
                  <Text style={styles.name}>{i.email}</Text>
                  <Text style={styles.waiting}>
                    {[roleName(i.role), i.phone].filter(Boolean).join(' · ')}
                  </Text>
                  <Button
                    kind="link"
                    label={z.cancelInvitation}
                    a11yLabel={`${z.cancelInvitation}: ${i.email}`}
                    onPress={() =>
                      void act(() => api.cancelInvitation(salon.orgId, i.id), z.cancelled)
                    }
                  />
                </Card>
              ))}
            </>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
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
  section: { fontSize: 18, fontWeight: '700', color: colors.ink, marginTop: 8 },
  name: { fontSize: 17, fontWeight: '600', color: colors.ink },
  text: { fontSize: 15, color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
  ok: { color: '#2e7d32', fontSize: 15 },
  waiting: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  info: { color: '#2e7d32', fontSize: 15 },
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
