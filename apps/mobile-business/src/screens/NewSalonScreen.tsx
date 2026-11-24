import { useMemo, useRef, useState, type ComponentRef } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type BusinessApi, type Locale } from '../api';
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
  const inputs = useRef<Partial<Record<TextKey, ComponentRef<typeof TextInput> | null>>>({});
  const [problem, setProblem] = useState<NewSalonProblem | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const creating = useRef(false);
  const [busy, setBusy] = useState(false);
  const poland = regionForTimeZone(form.timezone) === 'PL';

  const { timezone, currency } = form;
  const countryChoices = useMemo(
    () => (
      <Card>
        <Text style={styles.section}>{t.salon.country}</Text>
        <ChoiceList
          t={t}
          label={t.salon.timeZone}
          hint={t.salon.timeZoneHint}
          value={timezone}
          options={salonTimeZones(locale).map((z) => ({ value: z.timeZone, label: z.label }))}
          onChange={(timezone) => {
            setForm((current) => withTimeZone(current, timezone));
            setProblem((current) => (current === 'postalCode' ? null : current));
          }}
        />
        <ChoiceList
          t={t}
          label={t.salon.currency}
          hint={t.newSalon.currencyHint}
          value={currency}
          options={CURRENCIES.map((c) => ({ value: c, label: currencyName(c, locale) }))}
          onChange={(currency) =>
            setForm((current) => ({ ...current, currency, currencyChosen: true }))
          }
        />
      </Card>
    ),
    [t, locale, timezone, currency],
  );

  const problems: Record<NewSalonProblem, string> = {
    orgName: n.badOrgName,
    locationName: n.badLocationName,
    address: t.salon.badAddress,
    city: t.salon.badCity,
    postalCode: poland ? n.badPostalCodePl : t.salon.badPostalCode,
  };

  function showProblem(next: NewSalonProblem) {
    setProblem(next);
    inputs.current[next === 'address' ? 'addressLine' : next]?.focus();
  }

  async function create() {
    if (creating.current) return;
    setError('');
    const bodies = newSalonBodies(form, locale);
    if ('problem' in bodies) {
      showProblem(bodies.problem);
      return;
    }
    creating.current = true;
    setBusy(true);
    setProblem(null);
    let orgId = organizationId;
    try {
      if (!orgId) {
        const org = await props.api.createOrganization(bodies.organization);
        orgId = org.id;
        setOrganizationId(orgId);
      }
      await props.api.createLocation(orgId, bodies.location);
      props.onCreated();
    } catch (e) {
      creating.current = false;
      setBusy(false);
      const path = e instanceof ApiError && e.code === 'VALIDATION_ERROR' && e.details[0]?.path;
      if (path === 'name') showProblem(orgId ? 'locationName' : 'orgName');
      else if (path === 'addressLine') showProblem('address');
      else if (path === 'city' || path === 'postalCode') showProblem(path);
      else setError(errorText(e, t));
    }
  }

  const field = (
    key: TextKey,
    label: string,
    options: { maxLength: number; hint?: string; placeholder?: string; numeric?: boolean },
  ) => {
    const invalid = problem !== null && problem === (key === 'addressLine' ? 'address' : key);
    const fieldId = `new-salon-${key}`;
    const hintId = options.hint ? `${fieldId}-hint` : undefined;
    return (
      <View style={styles.field}>
        <Text nativeID={`${fieldId}-label`} style={styles.label}>
          {label}
        </Text>
        <TextInput
          ref={(input) => {
            inputs.current[key] = input;
          }}
          accessibilityLabel={label}
          aria-labelledby={`${fieldId}-label`}
          accessibilityHint={invalid ? problems[problem] : options.hint}
          editable={!busy && !(key === 'orgName' && organizationId)}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${fieldId}-error` : hintId}
          value={form[key]}
          multiline={key === 'addressLine'}
          numberOfLines={key === 'addressLine' ? 2 : undefined}
          submitBehavior="blurAndSubmit"
          maxLength={options.maxLength}
          keyboardType={options.numeric ? 'numbers-and-punctuation' : undefined}
          placeholder={options.placeholder}
          placeholderTextColor={colors.placeholder}
          onChangeText={(value) => {
            setForm({
              ...form,
              [key]: key === 'addressLine' ? value.replace(/[\r\n]+/g, ' ') : value,
            });
            if (
              invalid ||
              (key === 'orgName' && problem === 'locationName' && !form.locationName.trim())
            )
              setProblem(null);
          }}
          style={[styles.input, invalid && styles.invalid]}
        />
        {invalid ? (
          <Text
            nativeID={`${fieldId}-error`}
            role="alert"
            accessibilityLiveRegion="assertive"
            style={styles.fieldError}
          >
            ! {problems[problem]}
          </Text>
        ) : null}
        {options.hint ? (
          <Text nativeID={hintId} style={styles.small}>
            {options.hint}
          </Text>
        ) : null}
      </View>
    );
  };

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Button kind="link" label={t.salon.back} disabled={busy} onPress={props.onBack} />
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
      {countryChoices}
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
  invalid: { borderColor: colors.danger },
  fieldError: { color: colors.danger, fontSize: 15 },
  input: {
    minWidth: 0,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    backgroundColor: colors.card,
    color: colors.ink,
  },
});
