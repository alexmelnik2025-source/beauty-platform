import { useFormDraft } from '../formDrafts';
import { FormField } from '../formFields';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useState } from 'react';
import { Image, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { ApiError, type BusinessApi, type ServiceList, type StaffList } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  profileChanges,
  profileForm,
  serviceChoices,
  SPECIALTIES,
  type Specialty,
  type StaffProfileForm,
} from '../staffProfile';
import { photoType, uploadErrorText } from '../salonPhotos';
import { Button, Card, colors, ErrorText, Pressable, switchTouchTarget } from '../ui';
import type { SalonChoice } from './SalonsScreen';

type ProfileFields = Omit<StaffProfileForm, 'specialties' | 'serviceIds'>;
type ChoiceEdit<T> = { id: T; selected: boolean };
type ProfileDraft = Partial<ProfileFields> & {
  specialties?: ChoiceEdit<Specialty>[];
  serviceIds?: ChoiceEdit<string>[];
};

/** Untouched choices follow the server. Newly selected specialties come last (the first is primary). */
function editedChoices<T>(saved: T[], edits: ChoiceEdit<T>[] = []): T[] {
  return [
    ...saved.filter((id) => !edits.some((edit) => edit.id === id)),
    ...edits.filter((edit) => edit.selected).map((edit) => edit.id),
  ];
}

function editChoice<T>(
  saved: T[],
  edits: ChoiceEdit<T>[] = [],
  id: T,
  selected: boolean,
  ordered = false,
): ChoiceEdit<T>[] {
  const other = edits.filter((edit) => edit.id !== id);
  if (selected === saved.includes(id)) {
    // Re-selecting a specialty moves it to the end, which can change the primary specialty.
    if (!ordered || !selected || editedChoices(saved, other).at(-1) === id) return other;
  }
  return [...other, { id, selected }];
}

/**
 * Task 326: the top of a specialist's page in "Grafik zespołu" (owner or manager) — the name
 * clients see, a description, the specialties and "Przyjmuje klientów"; task 327: which services
 * they perform. Like the specialist's card in the cabinet's "Zespół". The server checks the rights
 * and the version (someone else may have saved the profile meanwhile). Task 339: the photo
 * clients see — from the phone's gallery (square), or removed.
 */
export function StaffProfileSection(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  staffId: string;
  /** The name changed: the page title and the team list show the new one. */
  onRenamed: (name: string) => void;
  /** Task 372: after the server saved the profile or the photo — the team list reloads. */
  onSaved?: () => void;
}) {
  const { api, t, salon, staffId, onRenamed } = props;
  const p = t.staffProfile;
  const [staff, setStaff] = useState<StaffList[number] | null>(null);
  const [services, setServices] = useState<ServiceList>([]);
  const [draft, setDraft] = useFormDraft<ProfileDraft | null>(`staffProfile.${staffId}`, null);
  const savedForm = staff && profileForm(staff);
  const form = savedForm &&
    draft && {
      ...savedForm,
      ...draft,
      specialties: editedChoices(savedForm.specialties, draft.specialties),
      serviceIds: editedChoices(savedForm.serviceIds, draft.serviceIds),
    };
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  /** Task 339: "Usunąć zdjęcie?" is open. */
  const [removingPhoto, setRemovingPhoto] = useState(false);

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

  function editField<K extends keyof ProfileFields>(key: K, value: ProfileFields[K]) {
    setDraft((current) => {
      if (!current || !savedForm) return current;
      const next = { ...current, [key]: value };
      if (value === savedForm[key]) delete next[key];
      return next;
    });
  }

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
      setDraft(null);
      return;
    }
    setBusy(true);
    let saved = staff;
    try {
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
      setDraft((current) => (current === draft ? null : current));
      setInfo(p.saved);
    } catch (e) {
      // The profile PATCH can succeed even if updating its services fails. Retry only the services.
      if (saved !== staff) {
        setStaff(saved);
        setDraft((current) =>
          current && current === draft ? { serviceIds: current.serviceIds } : current,
        );
      }
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setError(p.changedMeanwhile);
        setDraft((current) => (current === draft ? null : current));
        await load();
      } else setError(errorText(e, t));
    } finally {
      if (saved !== staff) {
        if (saved.displayName !== staff.displayName) onRenamed(saved.displayName);
        props.onSaved?.();
      }
      setBusy(false);
    }
  }

  /** Task 339: a square photo from the gallery replaces the old one. */
  async function pickPhoto() {
    setError('');
    setInfo('');
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    }).catch(() => null);
    if (!picked) return setError(t.salon.photoNoAccess);
    if (picked.canceled || picked.assets.length === 0) return;
    const asset = picked.assets[0]!;
    setBusy(true);
    try {
      const blob = await (await fetch(asset.uri)).blob();
      await api.setStaffPhoto(
        salon.orgId,
        salon.locationId,
        staffId,
        blob,
        photoType(asset.mimeType, blob.type),
      );
      await load();
      setInfo(p.photoSaved);
      props.onSaved?.();
    } catch (e) {
      setError(uploadErrorText(e, t) ?? errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto() {
    setRemovingPhoto(false);
    setError('');
    setInfo('');
    setBusy(true);
    try {
      await api.removeStaffPhoto(salon.orgId, salon.locationId, staffId);
      await load();
      setInfo(p.photoRemoved);
      props.onSaved?.();
    } catch (e) {
      setError(errorText(e, t));
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
      {error && error !== p.noName ? <ErrorText>{error}</ErrorText> : null}
      {info ? <Text style={styles.info}>{info}</Text> : null}
      {!form ? (
        <>
          <Card>
            {/* Task 339: the photo clients see next to the name. */}
            <View style={styles.photoRow}>
              {staff.photoUrl ? (
                <Image
                  source={{ uri: api.absoluteUrl(staff.photoUrl) }}
                  accessibilityLabel={fill(p.photoAlt, { name: staff.displayName })}
                  accessibilityIgnoresInvertColors
                  style={styles.photo}
                />
              ) : (
                <View style={[styles.photo, styles.initials]}>
                  <Text style={styles.initialsText}>{initials(staff.displayName)}</Text>
                </View>
              )}
              <View style={{ gap: 4, flexShrink: 1 }}>
                <Button
                  kind="secondary"
                  label={staff.photoUrl ? p.photoChange : p.photoAdd}
                  busy={busy && !removingPhoto}
                  onPress={() => void pickPhoto()}
                />
                {staff.photoUrl && !removingPhoto ? (
                  <Button
                    kind="link"
                    label={p.photoRemove}
                    disabled={busy}
                    onPress={() => {
                      setInfo('');
                      setRemovingPhoto(true);
                    }}
                  />
                ) : null}
              </View>
            </View>
            {removingPhoto ? (
              <View style={{ gap: 4 }}>
                <Text style={styles.muted}>{p.photoRemoveAsk}</Text>
                <View style={styles.photoRow}>
                  <Button label={p.photoYes} busy={busy} onPress={() => void removePhoto()} />
                  <Button
                    kind="secondary"
                    label={p.photoNo}
                    onPress={() => setRemovingPhoto(false)}
                  />
                </View>
              </View>
            ) : null}
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
              setDraft({});
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
              style={switchTouchTarget}
              accessibilityLabel={p.active}
              value={form.active}
              onValueChange={(active) => editField('active', active)}
              trackColor={{ true: colors.accent, false: colors.line }}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{p.name}</Text>
            <FormField
              error={error === p.noName ? error : undefined}
              accessibilityLabel={p.name}
              value={form.displayName}
              maxLength={80}
              onChangeText={(displayName) => editField('displayName', displayName)}
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
              onChangeText={(bio) => editField('bio', bio)}
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
                    accessibilityLabel={p.names[code]}
                    key={code}
                    accessibilityRole="button"
                    aria-pressed={on}
                    accessibilityState={{ selected: on }}
                    onPress={() =>
                      setDraft(
                        (current) =>
                          current && {
                            ...current,
                            specialties: editChoice(
                              staff.specialties,
                              current.specialties,
                              code,
                              !on,
                              true,
                            ),
                          },
                      )
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
              onChangeText={(customSpecialty) => editField('customSpecialty', customSpecialty)}
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
                    setDraft(
                      (current) =>
                        current && {
                          ...current,
                          serviceIds: editChoice(
                            staff.serviceIds,
                            current.serviceIds,
                            service.id,
                            !on,
                          ),
                        },
                    )
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
            <Button kind="link" label={p.cancel} onPress={() => setDraft(null)} />
          </View>
        </Card>
      )}
    </>
  );
}

/** "Kasia Nowak" → "KN" — shown when there is no photo. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

const styles = StyleSheet.create({
  photoRow: { flexDirection: 'row', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  photo: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.soft },
  initials: { alignItems: 'center', justifyContent: 'center' },
  initialsText: { fontSize: 22, fontWeight: '700', color: colors.muted },
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
