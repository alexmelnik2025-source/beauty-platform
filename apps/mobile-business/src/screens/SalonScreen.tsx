import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useState } from 'react';
import {
  BackHandler,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { BusinessApi, Locale, Location, SalonPhoto } from '../api';
import { photosLeft, photoType, uploadErrorText } from '../salonPhotos';
import { CURRENCIES, currencyName, matching, salonTimeZones } from '../country';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import {
  LEGAL_KEYS,
  placeholders,
  SLOT_STEPS,
  salonChanges,
  salonForm,
  saveProblem,
  toggleDrink,
  type LegalKey,
  type SalonForm,
  type SalonProblem,
} from '../salon';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import { SPOKEN, toggleLanguage } from '../profile';
import { DRINK_ICON, MOOD_ICON, OFFERED_DRINKS } from '../wishes';
import type { SalonChoice } from './SalonsScreen';

type SettingsSection =
  'online' | 'details' | 'languages' | 'country' | 'rules' | 'questions' | 'legal' | 'photos';

/**
 * "Salon" (task 131): the owner or a manager changes the salon's name, address, phone and
 * description and switches online booking on or off. Opening hours, prices and the booking
 * terms stay in their own places (the team's schedule, "Usługi", the salon dashboard).
 * Task 319: "Zasady rezerwacji" — the lead time, how far ahead, the change deadline, the step.
 * Task 320: "Pytania przy rezerwacji" — mood, a drink (and which ones the salon has), a note.
 * Task 321: "Miejsce na mapie katalogu" — the coordinates as Google Maps gives them.
 * Task 322: "Języki w salonie" — the languages shown on the booking page.
 * Task 323: "Kraj i strefa czasowa" and "Waluta cen" — chosen from the cabinet's lists.
 * Task 324: "Regulamin i prywatność" — the two texts, with the server's template to start from.
 * Task 325: "Zdjęcia salonu" — the photos on the booking page; one is removed at once (after
 * "Usunąć?"). Task 337: "+ Dodaj zdjęcie" — from the phone's gallery (several at once, up to 10).
 */
export function SalonScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  onBack: () => void;
  /** The salon's name changed: the calendar's header shows the new one. */
  onRenamed: (name: string) => void;
}) {
  const { api, t, locale, salon, onBack, onRenamed } = props;
  const s = t.salon;
  const [section, setSection] = useState<SettingsSection | null>(null);
  const [fieldProblem, setFieldProblem] = useState<SalonProblem | null>(null);
  const [location, setLocation] = useState<Location | null>(null);
  const [form, setForm] = useState<SalonForm | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  /** Task 324: the text whose template waits for "replace?"; a template was put in (not saved). */
  const [replacing, setReplacing] = useState<LegalKey | null>(null);
  const [templated, setTemplated] = useState(false);
  /** Task 325: the salon's photos (null while loading) and the one waiting for "remove?". */
  const [photos, setPhotos] = useState<SalonPhoto[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  /** Task 337: photos are being sent. */
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try {
      const saved = await api.location(salon.orgId, salon.locationId);
      setLocation(saved);
      setForm(salonForm(saved));
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .salonPhotos(salon.orgId, salon.locationId)
      .then(setPhotos)
      .catch((e: unknown) => setError(errorText(e, t)));
  }, [api, salon, t]);

  async function removePhoto(id: string) {
    setRemoving(null);
    setError('');
    setInfo('');
    try {
      await api.removeSalonPhoto(salon.orgId, salon.locationId, id);
      setPhotos((list) => list && list.filter((p) => p.id !== id));
      setInfo(s.photoRemoved);
    } catch (e) {
      setError(errorText(e, t));
    }
  }

  /** Task 337: photos from the gallery, one after another, as many as still fit. */
  async function addPhotos() {
    const left = photosLeft(photos?.length ?? 0);
    setError('');
    setInfo('');
    if (left === 0) return setError(s.photosFull);
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: left > 1,
      selectionLimit: left,
      // Smaller files: the API takes at most 3 MB per photo.
      quality: 0.7,
    }).catch(() => null);
    if (!picked) return setError(s.photoNoAccess);
    if (picked.canceled || picked.assets.length === 0) return;
    setUploading(true);
    try {
      for (const asset of picked.assets) {
        const blob = await (await fetch(asset.uri)).blob();
        const saved = await api.addSalonPhoto(
          salon.orgId,
          salon.locationId,
          blob,
          photoType(asset.mimeType, blob.type),
        );
        setPhotos((list) => [...(list ?? []), saved]);
      }
      setInfo(s.photoAdded);
    } catch (e) {
      setError(uploadErrorText(e, t) ?? errorText(e, t));
    } finally {
      setUploading(false);
    }
  }

  const dirty =
    location !== null &&
    form !== null &&
    JSON.stringify(salonForm(location)) !== JSON.stringify(form);

  const goBack = useCallback(() => {
    if (busy || uploading) return;
    if (section) {
      setSection(null);
      setError('');
      setInfo('');
    } else if (!dirty) {
      onBack();
    }
  }, [section, busy, uploading, dirty, onBack]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      goBack();
      return true;
    });
    return () => sub.remove();
  }, [goBack]);

  function discard() {
    if (!location) return;
    setForm(salonForm(location));
    setError('');
    setInfo('');
    setFieldProblem(null);
    setReplacing(null);
    setTemplated(false);
  }

  const problems: Record<SalonProblem, string> = {
    name: s.badName,
    address: s.badAddress,
    city: s.badCity,
    postalCode: s.badPostalCode,
    phone: s.badPhone,
    lead: s.badLead,
    horizon: s.badHorizon,
    deadline: s.badDeadline,
    coordinates: s.badCoordinates,
    legalTooLong: s.legalTooLong,
  };

  /** Task 324: the template replaces the text (asked first when something is written). */
  async function insertTemplate(key: LegalKey, confirmed = false) {
    if (!form) return;
    if (form[key].trim() && !confirmed) {
      setReplacing(key);
      return;
    }
    setReplacing(null);
    setError('');
    try {
      const templates = await api.legalTemplates(salon.orgId, salon.locationId);
      setForm((current) => (current ? { ...current, [key]: templates[key] } : current));
      setTemplated(true);
    } catch (e) {
      setError(errorText(e, t));
    }
  }

  async function save() {
    if (!location || !form || busy) return;
    setError('');
    setInfo('');
    setFieldProblem(null);
    const checked = salonChanges(location, form);
    if ('problem' in checked) {
      if (checked.problem === 'legalTooLong') setSection('legal');
      else if (['lead', 'horizon', 'deadline'].includes(checked.problem)) setSection('rules');
      else setSection('details');
      if (checked.problem === 'legalTooLong') setError(problems.legalTooLong);
      else setFieldProblem(checked.problem);
      return;
    }
    if (Object.keys(checked.changes).length === 0) {
      setForm(salonForm(location));
      setTemplated(false);
      setInfo(s.nothing);
      return;
    }
    setBusy(true);
    try {
      const saved = await api.updateLocation(
        salon.orgId,
        salon.locationId,
        location.version,
        checked.changes,
      );
      setLocation(saved);
      setForm((current) => (current === form ? salonForm(saved) : current));
      setTemplated(false);
      setInfo(s.saved);
      if (saved.name !== location.name) onRenamed(saved.name);
    } catch (e) {
      const problem = saveProblem(e);
      if (problem === 'legalTexts') {
        setSection('legal');
        setError(s.legalTexts);
      } else if (problem === 'changedMeanwhile') {
        setError(s.changedMeanwhile);
        await load();
      } else setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  const field = (
    key:
      | 'name'
      | 'addressLine'
      | 'city'
      | 'postalCode'
      | 'phone'
      | 'minLeadMinutes'
      | 'bookingHorizonDays'
      | 'clientCancelDeadlineMinutes'
      | 'coordinates',
    label: string,
    options: {
      maxLength: number;
      keyboardType?: 'phone-pad' | 'number-pad' | 'numbers-and-punctuation';
      hint?: string;
      placeholder?: string;
    },
  ) => {
    const problemByField = {
      name: 'name',
      addressLine: 'address',
      city: 'city',
      postalCode: 'postalCode',
      phone: 'phone',
      minLeadMinutes: 'lead',
      bookingHorizonDays: 'horizon',
      clientCancelDeadlineMinutes: 'deadline',
      coordinates: 'coordinates',
    } as const;
    const problem = fieldProblem === problemByField[key] ? problems[fieldProblem] : null;
    return form ? (
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <TextInput
          accessibilityLabel={label}
          value={form[key]}
          maxLength={options.maxLength}
          keyboardType={options.keyboardType}
          placeholder={options.placeholder}
          placeholderTextColor={colors.placeholder}
          onChangeText={(value) => {
            if (problem) setFieldProblem(null);
            setForm({ ...form, [key]: value });
          }}
          style={[styles.input, problem && styles.invalid]}
        />
        {problem ? <ErrorText>{`! ${problem}`}</ErrorText> : null}
        {options.hint ? <Text style={styles.small}>{options.hint}</Text> : null}
      </View>
    ) : null;
  };

  /** Task 320: one question on the last booking step, switched on or off. */
  const question = (key: 'askMood' | 'askDrink' | 'askNote', text: string, label: string) =>
    form ? (
      <View style={[styles.switchRow, { marginTop: 10 }]}>
        <Text style={[styles.value, { flex: 1, fontWeight: '400' }]}>{text}</Text>
        <Switch
          accessibilityLabel={label}
          value={form[key]}
          onValueChange={(on) => setForm({ ...form, [key]: on })}
          trackColor={{ true: colors.accent, false: colors.line }}
        />
      </View>
    ) : null;

  const sections: { key: SettingsSection; icon: string; title: string; hint: string }[] = [
    {
      key: 'online',
      icon: '↗',
      title: s.online,
      hint: form?.onlineBookingEnabled ? s.onlineOn : s.onlineOff,
    },
    {
      key: 'details',
      icon: '⌂',
      title: t.navigation.salonDetails,
      hint: location?.name ?? salon.locationName,
    },
    { key: 'languages', icon: '◎', title: s.languages, hint: s.languagesHint },
    { key: 'country', icon: '◷', title: s.country, hint: s.timeZoneHint },
    { key: 'rules', icon: '▦', title: s.rules, hint: s.stepHint },
    { key: 'questions', icon: '?', title: s.questions, hint: s.questionsHint },
    { key: 'legal', icon: '§', title: s.legal, hint: s.legalHint },
    { key: 'photos', icon: '▧', title: s.photos, hint: s.photosHint },
  ];
  const selected = sections.find((item) => item.key === section);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        key={section ?? 'settings'}
        contentContainerStyle={styles.screen}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.row}>
          <Button
            kind="link"
            label={selected ? `‹ ${t.navigation.settings}` : s.back}
            onPress={goBack}
            disabled={busy || uploading || (!selected && dirty)}
          />
        </View>
        <Heading>{selected?.title ?? t.navigation.settings}</Heading>
        {error ? <ErrorText>{error}</ErrorText> : null}
        {info ? (
          <Text style={styles.info} role="status">
            {info}
          </Text>
        ) : null}
        {form ? (
          selected ? (
            {
              online: (
                <Card>
                  <View style={styles.switchRow}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.value}>{s.online}</Text>
                      <Text style={styles.small}>
                        {form.onlineBookingEnabled ? s.onlineOn : s.onlineOff}
                      </Text>
                    </View>
                    <Switch
                      accessibilityLabel={s.online}
                      value={form.onlineBookingEnabled}
                      onValueChange={(onlineBookingEnabled) =>
                        setForm({ ...form, onlineBookingEnabled })
                      }
                      trackColor={{ true: colors.accent, false: colors.line }}
                    />
                  </View>
                </Card>
              ),
              details: (
                <Card>
                  {field('name', s.name, { maxLength: 100 })}
                  {field('addressLine', s.address, { maxLength: 200 })}
                  {field('city', s.city, { maxLength: 100 })}
                  {field('postalCode', s.postalCode, { maxLength: 12 })}
                  {field('phone', s.phone, {
                    maxLength: 20,
                    keyboardType: 'phone-pad',
                    hint: s.phoneHint,
                  })}
                  <View style={styles.field}>
                    <Text style={styles.label}>{s.description}</Text>
                    <TextInput
                      accessibilityLabel={s.description}
                      value={form.description}
                      maxLength={1000}
                      multiline
                      numberOfLines={4}
                      onChangeText={(description) => setForm({ ...form, description })}
                      style={[styles.input, styles.multiline]}
                    />
                    <Text style={styles.small}>{s.descriptionHint}</Text>
                  </View>
                  {location && (location.latitude === null || location.longitude === null) ? (
                    <Text role="note" style={styles.note}>
                      {s.notOnMap}
                    </Text>
                  ) : null}
                  {field('coordinates', s.map, {
                    maxLength: 60,
                    keyboardType: 'numbers-and-punctuation',
                    hint: s.mapHint,
                    placeholder: '52.23251, 20.95634',
                  })}
                </Card>
              ),
              languages: (
                <Card>
                  <Text style={styles.section}>{s.languages}</Text>
                  <Text style={styles.small}>{s.languagesHint}</Text>
                  <View style={[styles.row, { marginTop: 10 }]}>
                    {SPOKEN.map((l) => {
                      const on = form.languages.includes(l.code);
                      return (
                        <Pressable
                          key={l.code}
                          accessibilityRole="checkbox"
                          accessibilityLabel={l.name}
                          accessibilityState={{ checked: on }}
                          aria-checked={on}
                          onPress={() =>
                            setForm({ ...form, languages: toggleLanguage(form.languages, l.code) })
                          }
                          style={[styles.chip, on && styles.chipOn]}
                        >
                          <Text style={[styles.chipText, on && { color: '#fff' }]}>
                            {l.flag} {l.name}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </Card>
              ),
              country: (
                <Card>
                  <Text style={styles.section}>{s.country}</Text>
                  <ChoiceList
                    t={t}
                    label={s.timeZone}
                    hint={s.timeZoneHint}
                    value={form.timezone}
                    options={salonTimeZones(locale, location?.timezone).map((z) => ({
                      value: z.timeZone,
                      label: z.label,
                    }))}
                    onChange={(timezone) => setForm({ ...form, timezone })}
                  />
                  <ChoiceList
                    t={t}
                    label={s.currency}
                    hint={s.currencyHint}
                    value={form.currency}
                    options={CURRENCIES.map((c) => ({ value: c, label: currencyName(c, locale) }))}
                    onChange={(currency) => setForm({ ...form, currency })}
                  />
                </Card>
              ),
              rules: (
                <Card>
                  <Text style={styles.section}>{s.rules}</Text>
                  {field('minLeadMinutes', s.lead, {
                    maxLength: 5,
                    keyboardType: 'number-pad',
                    hint: s.leadHint,
                  })}
                  {field('bookingHorizonDays', s.horizon, {
                    maxLength: 3,
                    keyboardType: 'number-pad',
                  })}
                  {field('clientCancelDeadlineMinutes', s.deadline, {
                    maxLength: 5,
                    keyboardType: 'number-pad',
                    hint: s.deadlineHint,
                  })}
                  <View style={styles.field}>
                    <Text style={styles.label}>{s.step}</Text>
                    <View style={styles.row}>
                      {SLOT_STEPS.map((minutes) => (
                        <Chip
                          key={minutes}
                          label={fill(s.stepMinutes, { n: String(minutes) })}
                          on={form.slotStepMinutes === minutes}
                          onPress={() => setForm({ ...form, slotStepMinutes: minutes })}
                        />
                      ))}
                    </View>
                    <Text style={styles.small}>{s.stepHint}</Text>
                  </View>
                </Card>
              ),
              questions: (
                <Card>
                  <Text style={styles.section}>{s.questions}</Text>
                  <Text style={styles.small}>{s.questionsHint}</Text>
                  {question(
                    'askMood',
                    `${MOOD_ICON.chat} ${MOOD_ICON.quiet} ${MOOD_ICON.relax} ${s.askMood}`,
                    s.askMood,
                  )}
                  {question('askDrink', `${DRINK_ICON.coffee} ${s.askDrink}`, s.askDrink)}
                  {form.askDrink ? (
                    <View style={[styles.field, { paddingLeft: 12 }]}>
                      <Text style={styles.label}>{s.drinksOffered}</Text>
                      <View style={styles.row}>
                        {OFFERED_DRINKS.map((drink) => (
                          <Chip
                            key={drink}
                            label={`${DRINK_ICON[drink]} ${t.visit.drink[drink]}`}
                            on={form.drinks.includes(drink)}
                            onPress={() =>
                              setForm({ ...form, drinks: toggleDrink(form.drinks, drink) })
                            }
                          />
                        ))}
                      </View>
                    </View>
                  ) : null}
                  {question('askNote', `✍️ ${s.askNote}`, s.askNote)}
                </Card>
              ),
              legal: (
                <Card>
                  <Text style={styles.section}>{s.legal}</Text>
                  <Text style={styles.small}>{s.legalHint}</Text>
                  {LEGAL_KEYS.map((key) => {
                    const label = key === 'bookingTerms' ? s.terms : s.privacy;
                    return (
                      <View key={key} style={[styles.field, { marginTop: 10 }]}>
                        <Text style={styles.label}>{label}</Text>
                        <TextInput
                          accessibilityLabel={label}
                          value={form[key]}
                          maxLength={50000}
                          multiline
                          numberOfLines={8}
                          onChangeText={(value) => setForm({ ...form, [key]: value })}
                          style={[styles.input, styles.legal]}
                        />
                        {replacing === key ? (
                          <View style={styles.row}>
                            <Text style={[styles.small, { flexBasis: '100%' }]}>
                              {s.replaceAsk}
                            </Text>
                            <Button
                              kind="secondary"
                              label={s.replaceYes}
                              onPress={() => void insertTemplate(key, true)}
                            />
                            <Button
                              kind="link"
                              label={s.replaceNo}
                              onPress={() => setReplacing(null)}
                            />
                          </View>
                        ) : (
                          <View style={styles.row}>
                            <Button
                              kind="link"
                              label={s.useTemplate}
                              a11yLabel={`${s.useTemplate}: ${label}`}
                              onPress={() => void insertTemplate(key)}
                            />
                          </View>
                        )}
                      </View>
                    );
                  })}
                  <Text style={styles.small}>{s.markdownHint}</Text>
                  {templated ? (
                    <Text role="note" style={[styles.note, { marginTop: 10 }]}>
                      {s.templateNote}
                    </Text>
                  ) : null}
                  {placeholders(form.bookingTerms, form.privacyPolicy).length > 0 ? (
                    <Text role="status" style={[styles.note, { marginTop: 10 }]}>
                      {fill(s.missing, {
                        list: placeholders(form.bookingTerms, form.privacyPolicy).join(', '),
                      })}
                    </Text>
                  ) : null}
                </Card>
              ),
              photos: (
                <Card>
                  <Text style={styles.section}>{s.photos}</Text>
                  <Text style={styles.small}>{s.photosHint}</Text>
                  {photos && photos.length === 0 ? (
                    <Text style={[styles.small, { marginTop: 10 }]}>{s.photosNone}</Text>
                  ) : null}
                  <View style={[styles.row, { marginTop: 10 }]}>
                    {(photos ?? []).map((photo, i) => {
                      const name = fill(s.photo, { n: String(i + 1) });
                      return (
                        <View key={photo.id} style={styles.photoBox}>
                          <Image
                            source={{ uri: api.absoluteUrl(photo.url) }}
                            accessibilityLabel={name}
                            accessibilityIgnoresInvertColors
                            style={styles.photo}
                          />
                          {removing === photo.id ? (
                            <View style={{ gap: 4 }}>
                              <Text style={styles.small}>{s.photoRemoveAsk}</Text>
                              <Button
                                kind="secondary"
                                label={s.photoRemoveYes}
                                a11yLabel={`${s.photoRemoveYes}: ${name}`}
                                onPress={() => void removePhoto(photo.id)}
                              />
                              <Button
                                kind="link"
                                label={s.replaceNo}
                                onPress={() => setRemoving(null)}
                              />
                            </View>
                          ) : (
                            <Button
                              kind="link"
                              label={s.photoRemove}
                              a11yLabel={`${s.photoRemove}: ${name}`}
                              onPress={() => setRemoving(photo.id)}
                            />
                          )}
                        </View>
                      );
                    })}
                  </View>
                  {photos ? (
                    <View style={[styles.row, { marginTop: 10 }]}>
                      <Button
                        kind="secondary"
                        label={uploading ? s.photoUploading : s.photoAdd}
                        disabled={uploading || photosLeft(photos.length) === 0}
                        onPress={() => void addPhotos()}
                      />
                    </View>
                  ) : null}
                  {photos && photosLeft(photos.length) === 0 ? (
                    <Text style={styles.small}>{s.photosFull}</Text>
                  ) : null}
                </Card>
              ),
            }[selected.key]
          ) : (
            <Card>
              {sections.map((item) => (
                <Pressable
                  key={item.key}
                  accessibilityRole="button"
                  onPress={() => {
                    setError('');
                    setInfo('');
                    setSection(item.key);
                  }}
                  style={styles.settingsRow}
                >
                  <Text aria-hidden style={styles.settingsIcon}>
                    {item.icon}
                  </Text>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.value}>{item.title}</Text>
                    <Text numberOfLines={1} style={styles.small}>
                      {item.hint}
                    </Text>
                  </View>
                  <Text aria-hidden style={styles.small}>
                    ›
                  </Text>
                </Pressable>
              ))}
            </Card>
          )
        ) : !error ? (
          <Text style={styles.muted}>{t.loading}</Text>
        ) : null}
      </ScrollView>
      {dirty ? (
        <View style={styles.saveBar}>
          <Text accessibilityLiveRegion="polite" style={styles.value}>
            {t.navigation.unsaved}
          </Text>
          <View style={styles.row}>
            <Button
              kind="secondary"
              label={t.navigation.discard}
              disabled={busy}
              onPress={discard}
            />
            <Button label={s.save} busy={busy} onPress={() => void save()} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Task 323: the chosen value with "Zmień"; open, a search field and the list to tap one in.
 * Long lists (50 countries) stay short on a phone this way.
 */
export function ChoiceList<T extends string>(props: {
  t: Dictionary;
  label: string;
  hint: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const s = props.t.salon;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const chosen = props.options.find((o) => o.value === props.value)?.label ?? props.value;
  const shown = matching(props.options, typed);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      <View style={styles.switchRow}>
        <Text style={[styles.value, { flex: 1 }]} accessibilityLabel={`${props.label}: ${chosen}`}>
          {chosen}
        </Text>
        <Button
          kind="link"
          label={open ? s.choiceClose : s.choiceChange}
          a11yLabel={`${open ? s.choiceClose : s.choiceChange}: ${props.label}`}
          onPress={() => {
            setOpen(!open);
            setTyped('');
          }}
        />
      </View>
      {open ? (
        <View style={{ gap: 6 }}>
          <TextInput
            accessibilityLabel={fill(s.choiceSearch, { what: props.label })}
            placeholder={s.choiceSearchPlaceholder}
            placeholderTextColor={colors.placeholder}
            value={typed}
            onChangeText={setTyped}
            style={styles.input}
          />
          <ScrollView
            nestedScrollEnabled
            accessibilityRole="radiogroup"
            accessibilityLabel={props.label}
            style={styles.list}
            contentContainerStyle={{ gap: 2 }}
            keyboardShouldPersistTaps="handled"
          >
            {shown.length === 0 ? <Text style={styles.small}>{s.choiceNone}</Text> : null}
            {shown.map((option) => {
              const on = option.value === props.value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityLabel={option.label}
                  accessibilityState={{ checked: on }}
                  aria-checked={on}
                  onPress={() => {
                    props.onChange(option.value);
                    setOpen(false);
                    setTyped('');
                  }}
                  style={[styles.option, on && styles.optionOn]}
                >
                  <Text style={[styles.chipText, on && { fontWeight: '700' }]}>
                    {on ? '✓ ' : ''}
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      <Text style={styles.small}>{props.hint}</Text>
    </View>
  );
}

function Chip(props: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
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
  invalid: { borderColor: colors.danger },
  settingsRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  settingsIcon: { color: colors.ink, fontSize: 19, width: 24, textAlign: 'center' },
  saveBar: {
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 6,
  },
  screen: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  switchRow: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  field: { gap: 4, marginBottom: 10 },
  label: { fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  value: { fontSize: 16, color: colors.ink, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
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
  multiline: { minHeight: 96, textAlignVertical: 'top' },
  photoBox: { width: 140, gap: 4 },
  photo: { width: 140, height: 105, borderRadius: 10, backgroundColor: colors.soft },
  legal: { minHeight: 180, maxHeight: 360, textAlignVertical: 'top', fontSize: 14 },
  note: {
    color: colors.ink,
    fontSize: 14,
    backgroundColor: colors.soft,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  section: { fontSize: 16, color: colors.ink, fontWeight: '700', marginBottom: 10 },
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
  list: { maxHeight: 320 },
  option: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10 },
  optionOn: { backgroundColor: colors.soft },
});
