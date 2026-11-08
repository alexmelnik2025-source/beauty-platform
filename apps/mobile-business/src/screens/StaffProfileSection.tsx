import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { ApiError, type BusinessApi, type ServiceList, type StaffList } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  profileChanges,
  profileForm,
  serviceChoices,
  SPECIALTIES,
  toggleSpecialty,
  type StaffProfileForm,
} from '../staffProfile';
import { toggled } from '../services';
import { Button, Card, colors, ErrorText } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 326: the top of a specialist's page in "Grafik zespołu" (owner or manager) — the name
 * clients see, a description, the specialties and "Przyjmuje klientów"; task 327: which services
 * they perform. Like the specialist's card in the cabinet's "Zespół". The server checks the rights
 * and the version (someone else may have saved the profile meanwhile).
 */
export function StaffProfileSection(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  staffId: string;
  /** The name changed: the page title and the team list show the new one. */
  onRenamed: (name: string) => void;
}) {
  const { api, t, salon, staffId, onRenamed } = props;
  const p = t.staffProfile;
  const [staff, setStaff] = useState<StaffList[number] | null>(null);
  const [services, setServices] = useState<ServiceList>([]);
  const [form, setForm] = useState<StaffProfileForm | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, offered] = await Promise.all([
        api.staff(salon.orgId, salon.locationId),
        api.services(salon.orgId, salon.locationId),
      ]);
      setStaff(list.find((s) => s.id === staffId) ?? null);
      setServices(offered);
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, staffId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!staff || !form || busy) return;
    setError('');
    setInfo('');
    const checked = profileChanges(staff, form);
    if ('problem' in checked) {
      setError(p.noName);
      return;
    }
    if (!checked.change && !checked.serviceIds) {
      setInfo(p.nothing);
      setForm(null);
      return;
    }
    setBusy(true);
    try {
      let saved = staff;
      if (checked.change) {
        saved = await api.updateStaff(
          salon.orgId,
          salon.locationId,
          staffId,
          staff.version,
          checked.change,
        );
      }
      if (checked.serviceIds) {
        saved = await api.setStaffServices(
          salon.orgId,
          salon.locationId,
          staffId,
          checked.serviceIds,
        );
      }
      setStaff(saved);
      setForm(null);
      setInfo(p.saved);
      if (saved.displayName !== staff.displayName) onRenamed(saved.displayName);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setError(p.changedMeanwhile);
        setForm(null);
        await load();
      } else setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  if (!staff) return error ? <ErrorText>{error}</ErrorText> : null;

  const offered = services.filter((s) => s.active);
  const specialtyText = [
    ...staff.specialties.map((c) => p.names[c]),
    ...(staff.customSpecialty ? [staff.customSpecialty] : []),
  ].join(', ');

  return (
    <>
      <Text style={styles.section}>{p.title}</Text>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {info ? <Text style={styles.info}>{info}</Text> : null}
      {!form ? (
        <>
          <Card>
            <Text style={styles.value}>{specialtyText || p.noSpecialty}</Text>
            <Text style={styles.muted}>{staff.bio ?? p.noBio}</Text>
            <Text style={styles.muted}>
              {fill(p.servicesCount, {
                count: String(staff.serviceIds.length),
                all: String(offered.length),
              })}
            </Text>
            {staff.serviceIds.length === 0 ? <Text style={styles.warn}>{p.noServices}</Text> : null}
            <Text style={staff.active ? styles.muted : styles.warn}>
              {staff.active ? p.activeOn : p.activeOff}
            </Text>
          </Card>
          <Button
            kind="secondary"
            label={p.edit}
            onPress={() => {
              setInfo('');
              setError('');
              setForm(profileForm(staff));
            }}
          />
        </>
      ) : (
        <Card>
          <View style={styles.switchRow}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.value}>{p.active}</Text>
              <Text style={styles.small}>{form.active ? p.activeOn : p.activeOff}</Text>
            </View>
            <Switch
              accessibilityLabel={p.active}
              value={form.active}
              onValueChange={(active) => setForm({ ...form, active })}
              trackColor={{ true: colors.accent, false: colors.line }}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{p.name}</Text>
            <TextInput
              accessibilityLabel={p.name}
              value={form.displayName}
              maxLength={80}
              onChangeText={(displayName) => setForm({ ...form, displayName })}
              style={styles.input}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{p.bio}</Text>
            <TextInput
              accessibilityLabel={p.bio}
              value={form.bio}
              maxLength={500}
              multiline
              numberOfLines={3}
              onChangeText={(bio) => setForm({ ...form, bio })}
              style={[styles.input, styles.multiline]}
            />
            <Text style={styles.small}>{p.bioHint}</Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{p.specialties}</Text>
            <View style={styles.row}>
              {SPECIALTIES.map((code) => {
                const on = form.specialties.includes(code);
                return (
                  <Pressable
                    key={code}
                    accessibilityRole="button"
                    aria-pressed={on}
                    accessibilityState={{ selected: on }}
                    onPress={() =>
                      setForm({ ...form, specialties: toggleSpecialty(form.specialties, code) })
                    }
                    style={[styles.chip, on && styles.chipOn]}
                  >
                    <Text style={[styles.chipText, on && { color: '#fff' }]}>{p.names[code]}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.small}>{p.specialtiesHint}</Text>
            <TextInput
              accessibilityLabel={p.custom}
              placeholder={p.customHint}
              value={form.customSpecialty}
              maxLength={40}
              onChangeText={(customSpecialty) => setForm({ ...form, customSpecialty })}
              style={styles.input}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{p.services}</Text>
            <Text style={styles.small}>{p.servicesHint}</Text>
            {serviceChoices(services, form.serviceIds).map((service) => {
              const on = form.serviceIds.includes(service.id);
              return (
                <Pressable
                  key={service.id}
                  accessibilityRole="checkbox"
                  accessibilityLabel={service.name}
                  accessibilityState={{ checked: on }}
                  aria-checked={on}
                  onPress={() =>
                    setForm({ ...form, serviceIds: toggled(form.serviceIds, service.id) })
                  }
                  style={styles.check}
                >
                  <Text style={[styles.box, on && styles.boxOn]}>{on ? '✓' : ''}</Text>
                  <Text style={[styles.text, { flexShrink: 1 }]}>
                    {service.active ? service.name : `${service.name} · ${p.hidden}`}
                  </Text>
                </Pressable>
              );
            })}
            {form.serviceIds.length === 0 ? <Text style={styles.warn}>{p.noServices}</Text> : null}
          </View>

          <View style={styles.row}>
            <Button label={p.save} busy={busy} onPress={() => void save()} />
            <Button kind="link" label={p.cancel} onPress={() => setForm(null)} />
          </View>
        </Card>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  section: { marginTop: 8, fontSize: 13, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  switchRow: { flexDirection: 'row', gap: 12, alignItems: 'center', marginBottom: 12 },
  field: { gap: 6, marginBottom: 12 },
  label: { fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  value: { fontSize: 16, color: colors.ink, fontWeight: '600' },
  text: { fontSize: 15, color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  warn: { color: colors.danger, fontSize: 14 },
  info: { color: colors.ink, fontSize: 15 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    backgroundColor: colors.card,
    color: colors.ink,
  },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
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
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  box: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 6,
    textAlign: 'center',
    lineHeight: 20,
    color: '#fff',
    fontWeight: '700',
  },
  boxOn: { backgroundColor: colors.ink },
});
