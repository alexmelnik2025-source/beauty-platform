import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Locale } from '../api';
import { LANGUAGE_NAMES, LOCALES, type Dictionary } from '../i18n';
import { Button, colors, Pressable } from '../ui';

const codes: Record<Locale, string> = { pl: 'PL', uk: 'UA', ru: 'RU', en: 'EN' };

export function LanguagePicker({
  t,
  locale,
  onLocale,
  disabled = false,
}: {
  t: Dictionary;
  locale: Locale;
  onLocale: (locale: Locale) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.picker}>
      <Button
        kind="secondary"
        label={`${codes[locale]} ${open ? '▴' : '▾'}`}
        a11yLabel={`${t.language}: ${LANGUAGE_NAMES[locale]}`}
        disabled={disabled}
        compact
        expanded={open}
        onPress={() => setOpen((wasOpen) => !wasOpen)}
      />
      {open ? (
        <View role="group" accessibilityLabel={t.language}>
          {LOCALES.map((language) => (
            <Pressable
              key={language}
              accessibilityRole="button"
              accessibilityLanguage={language}
              disabled={disabled}
              accessibilityState={{ selected: language === locale, disabled }}
              aria-pressed={language === locale}
              style={[styles.option, language === locale && styles.selected]}
              onPress={() => {
                onLocale(language);
                setOpen(false);
              }}
            >
              <Text style={styles.name}>
                {codes[language]} · {LANGUAGE_NAMES[language]}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  picker: { alignSelf: 'flex-start', alignItems: 'flex-start', maxWidth: '100%' },
  option: { justifyContent: 'center', alignItems: 'center', padding: 8, borderRadius: 12 },
  selected: { backgroundColor: colors.soft },
  name: { fontSize: 16, fontWeight: '600', color: colors.ink, textAlign: 'center' },
});
