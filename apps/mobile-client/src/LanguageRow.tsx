import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Locale } from './api';
import { formFailure, validationField, type FormFailure } from './errors';
import { FieldGroup, FormFeedback } from './FormFeedback';
import { DICTIONARIES, LANGUAGE_NAMES, LOCALES } from './i18n';
import { Button, colors, Pressable } from './ui';

/** Each language named in itself; the chosen one is underlined. */
export function LanguageRow(props: {
  label: string;
  locale: Locale;
  onLocale: (locale: Locale) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<FormFailure | null>(null);

  async function choose(locale: Locale) {
    if (busy) return;
    setBusy(true);
    setInvalid(false);
    setFailure(null);
    setOpen(false);
    try {
      await props.onLocale(locale);
    } catch (error) {
      if (validationField(error, ['locale'])) setInvalid(true);
      else setFailure(formFailure(error, DICTIONARIES[locale], () => void choose(locale)));
    } finally {
      setBusy(false);
    }
  }

  const code = (locale: Locale) => (locale === 'uk' ? 'UA' : locale.toUpperCase());
  return (
    <View style={{ alignSelf: 'flex-start', marginTop: 12 }}>
      <FieldGroup error={invalid ? DICTIONARIES[props.locale].badLanguage : undefined}>
        <Button
          kind="link"
          label={`${code(props.locale)} ${open ? '▴' : '▾'}`}
          a11yLabel={props.label}
          expanded={open}
          disabled={busy}
          onPress={() => setOpen(!open)}
        />
        {open ? (
          <View style={styles.languages} accessibilityLabel={props.label}>
            {LOCALES.map((l) => {
              const label = l === 'uk' ? `UA · ${LANGUAGE_NAMES[l]}` : LANGUAGE_NAMES[l];
              const selected = l === props.locale;
              return (
                <Pressable
                  key={l}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={{ selected }}
                  aria-pressed={selected}
                  onPress={() => void choose(l)}
                  style={styles.languageButton}
                >
                  <Text style={[styles.language, selected && styles.languageActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </FieldGroup>
      <FormFeedback failure={failure} retryLabel={DICTIONARIES[props.locale].retry} busy={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  languages: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  languageButton: { justifyContent: 'center', paddingHorizontal: 4, maxWidth: '100%' },
  language: { color: colors.muted, fontSize: 14 },
  languageActive: { color: colors.ink, fontWeight: '700', textDecorationLine: 'underline' },
});
