import { StyleSheet, Text, View } from 'react-native';
import type { Locale } from './api';
import { LANGUAGE_NAMES, LOCALES } from './i18n';
import { colors } from './ui';

/** Each language named in itself; the chosen one is underlined. */
export function LanguageRow(props: {
  label: string;
  locale: Locale;
  onLocale: (locale: Locale) => void;
}) {
  return (
    <View style={styles.languages} accessibilityLabel={props.label}>
      {LOCALES.map((l) => (
        <Text
          key={l}
          accessibilityRole="button"
          aria-pressed={l === props.locale}
          onPress={() => props.onLocale(l)}
          style={[styles.language, l === props.locale && styles.languageActive]}
        >
          {LANGUAGE_NAMES[l]}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  languages: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 24 },
  language: { color: colors.muted, fontSize: 14, paddingVertical: 6 },
  languageActive: { color: colors.ink, fontWeight: '700', textDecorationLine: 'underline' },
});
