import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { BusinessApi, Locale } from '../api';
import {
  CURRENCIES,
  currencyName,
  regionForTimeZone,
  salonTimeZones,
  salonZoneOf,
} from '../country';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { emptyNewSalon, newSalonBodies, withTimeZone, type NewSalonProblem } from '../newSalon';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import { ChoiceList } from './SalonScreen';

type TextKey = 'orgName' | 'locationName' | 'addressLine' | 'city' | 'postalCode';

/**
 * Task 350, "Załóż salon": the company and its first salon for a person who has none yet (they
 * registered on the website and skipped its first step). After saving, the app opens the new
 * salon's day like after sign-in; services, team and hours are set as usual.
 */
export function NewSalonScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  onCreated: () => void;
  onBack: () => void;
}) {
  const { t, locale } = props;
  const n = t.newSalon;
  const [form, setForm] = useState(() =>
    emptyNewSalon(salonZoneOf(Intl.DateTimeFormat().resolvedOptions().timeZone)),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const poland = regionForTimeZone(form.timezone) === 'PL';

  const problems: Record<NewSalonProblem, string> = {
    orgName: n.badOrgName,
    locationName: n.badLocationName,
    address: t.salon.badAddress,
    city: t.salon.badCity,
    postalCode: poland ? n.badPostalCodePl : t.salon.badPostalCode,
  };

  async function create() {
    const bodies = newSalonBodies(form, locale);
    if ('problem' in bodies) {
      setError(problems[bodies.problem]);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const org = await props.api.createOrganization(bodies.organization);
      await props.api.createLocation(org.id, bodies.location);
      props.onCreated();
    } catch (e) {
      setError(errorText(e, t));
      setBusy(false);
    }
  }

  const field = (
    key: TextKey,
    label: string,
    options: { maxLength: number; hint?: string; placeholder?: string; numeric?: boolean },
  ) => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={form[key]}
        maxLength={options.maxLength}
        keyboardType={options.numeric ? 'numbers-and-punctuation' : undefined}
        placeholder={options.placeholder}
        placeholderTextColor={colors.placeholder}
        onChangeText={(value) => setForm({ ...form, [key]: value })}
        style={styles.input}
      />
      {options.hint ? <Text style={styles.small}>{options.hint}</Text> : null}
    </View>
  );

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Button kind="link" label={t.salon.back} onPress={props.onBack} />
      <Heading>{n.title}</Heading>
      <Text style={styles.muted}>{n.lead}</Text>
      <Card>
        {field('orgName', n.orgName, { maxLength: 120, hint: n.orgNameHint })}
        {field('locationName', n.locationName, { maxLength: 100, hint: n.locationNameHint })}
        {field('addressLine', t.salon.address, { maxLength: 200 })}
        {field('city', t.salon.city, { maxLength: 100 })}
        {field('postalCode', t.salon.postalCode, {
          maxLength: 12,
          numeric: true,
          placeholder: poland ? '00-000' : undefined,
        })}
      </Card>
      <Card>
        <Text style={styles.section}>{t.salon.country}</Text>
        <ChoiceList
          t={t}
          label={t.salon.timeZone}
          hint={t.salon.timeZoneHint}
          value={form.timezone}
          options={salonTimeZones(locale).map((z) => ({ value: z.timeZone, label: z.label }))}
          onChange={(timezone) => setForm(withTimeZone(form, timezone))}
        />
        <ChoiceList
          t={t}
          label={t.salon.currency}
          hint={n.currencyHint}
          value={form.currency}
          options={CURRENCIES.map((c) => ({ value: c, label: currencyName(c, locale) }))}
          onChange={(currency) => setForm({ ...form, currency, currencyChosen: true })}
        />
      </Card>
      <Text style={styles.small}>{n.after}</Text>
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button label={n.create} busy={busy} onPress={create} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  field: { gap: 4, marginBottom: 10 },
  label: { fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  muted: { color: colors.muted, fontSize: 15 },
  small: { color: colors.muted, fontSize: 13 },
  section: { fontSize: 16, color: colors.ink, fontWeight: '700', marginBottom: 10 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    backgroundColor: colors.card,
    color: colors.ink,
  },
});
