import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { CLIENT_LANGUAGES, type ContactsForm } from '../clientContacts';
import type { Dictionary } from '../i18n';
import { LANGUAGE_NAMES } from '../i18n';
import type { ClientProblem } from '../newVisit';
import { dialForTimeZone } from '../phone';
import { colors, ErrorText } from '../ui';

/**
 * Tasks 332–333: the client's name, phone, email and the language of their messages — the same
 * fields for a new client ("+ Dodaj klienta") and for "Zmień dane" in the card.
 */
export function ClientContactsFields(props: {
  t: Dictionary;
  form: ContactsForm;
  onChange: (form: ContactsForm) => void;
  problem: ClientProblem | null;
  timeZone: string;
}) {
  const { t, form, onChange, problem } = props;
  const k = t.clientCard;
  const input = (
    key: 'name' | 'phone' | 'email',
    label: string,
    extra: { placeholder?: string; keyboardType?: 'phone-pad' | 'email-address' },
  ) => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholder={extra.placeholder}
        placeholderTextColor={colors.placeholder}
        value={form[key]}
        maxLength={key === 'email' ? 254 : 100}
        keyboardType={extra.keyboardType}
        autoCapitalize={key === 'name' ? 'words' : 'none'}
        autoCorrect={false}
        onChangeText={(value) => onChange({ ...form, [key]: value })}
        style={styles.input}
      />
      {problem === key ? (
        <ErrorText>
          {key === 'name' ? k.badName : key === 'phone' ? k.badPhone : k.badEmail}
        </ErrorText>
      ) : null}
    </View>
  );
  // A language the app does not offer (set elsewhere) stays shown and chosen.
  const languages: ContactsForm['locale'][] = (CLIENT_LANGUAGES as string[]).includes(form.locale)
    ? CLIENT_LANGUAGES
    : [...CLIENT_LANGUAGES, form.locale];
  return (
    <>
      {input('name', k.name, {})}
      {input('phone', k.phone, {
        placeholder: `+${dialForTimeZone(props.timeZone)} 600 100 200`,
        keyboardType: 'phone-pad',
      })}
      {input('email', k.email, { keyboardType: 'email-address' })}
      <View style={styles.field}>
        <Text style={styles.label}>{k.language}</Text>
        <View style={styles.row}>
          {languages.map((code) => {
            const on = form.locale === code;
            const name = (LANGUAGE_NAMES as Record<string, string>)[code] ?? code.toUpperCase();
            return (
              <Pressable
                key={code}
                accessibilityRole="button"
                aria-pressed={on}
                accessibilityState={{ selected: on }}
                onPress={() => onChange({ ...form, locale: code })}
                style={[styles.chip, on && styles.chipOn]}
              >
                <Text style={[styles.chipText, on && { color: '#fff' }]}>{name}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  field: { gap: 4, marginBottom: 10 },
  label: { fontSize: 12, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    backgroundColor: colors.card,
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
