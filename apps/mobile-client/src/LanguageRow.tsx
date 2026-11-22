import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Locale } from './api';
import { LANGUAGE_NAMES, LOCALES } from './i18n';
import { Button, colors } from './ui';

/** Each language named in itself; the chosen one is underlined. */
export function LanguageRow(props: {
  label: string;
  locale: Locale;
  onLocale: (locale: Locale) => void;
}) {
  const [open, setOpen] = useState(false);
  const code = (locale: Locale) => (locale === 'uk' ? 'UA' : locale.toUpperCase());
  return (
    <View style={{ alignSelf: 'flex-start', marginTop: 12 }}>
      <Button
        kind="link"
        label={`${code(props.locale)} ${open ? '▴' : '▾'}`}
        a11yLabel={props.label}
        expanded={open}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <View style={styles.languages} accessibilityLabel={props.label}>
          {LOCALES.map((l) => (
            <Text
              key={l}
              accessibilityRole="button"
              aria-pressed={l === props.locale}
              onPress={() => {
                props.onLocale(l);
                setOpen(false);
              }}
              style={[styles.language, l === props.locale && styles.languageActive]}
            >
              {l === 'uk' ? `UA · ${LANGUAGE_NAMES[l]}` : LANGUAGE_NAMES[l]}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  languages: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  language: { color: colors.muted, fontSize: 14, paddingVertical: 6 },
  languageActive: { color: colors.ink, fontWeight: '700', textDecorationLine: 'underline' },
});
