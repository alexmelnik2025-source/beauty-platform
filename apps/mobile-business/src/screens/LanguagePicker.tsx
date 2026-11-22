import { useState } from 'react';
import { View } from 'react-native';
import type { Locale } from '../api';
import { LANGUAGE_NAMES, LOCALES, type Dictionary } from '../i18n';
import { Button } from '../ui';

const codes: Record<Locale, string> = { pl: 'PL', uk: 'UA', ru: 'RU', en: 'EN' };

export function LanguagePicker({
  t,
  locale,
  onLocale,
}: {
  t: Dictionary;
  locale: Locale;
  onLocale: (locale: Locale) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ alignSelf: 'flex-start' }}>
      <Button
        kind="secondary"
        label={`${codes[locale]} ${open ? '▴' : '▾'}`}
        a11yLabel={`${t.language}: ${LANGUAGE_NAMES[locale]}`}
        compact
        expanded={open}
        onPress={() => setOpen(!open)}
      />
      {open
        ? LOCALES.map((language) => (
            <Button
              key={language}
              kind="link"
              label={`${codes[language]} · ${LANGUAGE_NAMES[language]}`}
              selected={language === locale}
              onPress={() => {
                onLocale(language);
                setOpen(false);
              }}
            />
          ))
        : null}
    </View>
  );
}
