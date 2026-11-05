import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, parseContact, type BusinessApi, type Contact, type Locale } from '../api';
import { errorText } from '../errors';
import { fill, LANGUAGE_NAMES, LOCALES, type Dictionary } from '../i18n';
import { Button, colors, ErrorText, Heading } from '../ui';

/**
 * Sign-in without a password: email or phone from the invitation → 6-digit code.
 * There is no sign-up here — only the owner gives access, by invitation.
 */
export function SignInScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  onLocale: (locale: Locale) => void;
  onSignedIn: () => void;
}) {
  const { api, t, locale } = props;
  const [input, setInput] = useState('');
  const [contact, setContact] = useState<Contact | null>(null);
  const [sentText, setSentText] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    const parsed = parseContact(input);
    if (!parsed) return setError(t.signIn.badContact);
    setBusy(true);
    setError('');
    try {
      const sent = await api.requestCode(parsed, locale);
      const to = 'email' in parsed ? parsed.email : parsed.phone;
      setSentText(
        sent.channel === 'sms'
          ? fill(t.signIn.sentSms, { to })
          : 'phone' in parsed
            ? t.signIn.sentToInviteEmail
            : fill(t.signIn.sentEmail, { to }),
      );
      setContact(parsed);
      setCode('');
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!contact) return;
    setBusy(true);
    setError('');
    try {
      await api.verifyCode(contact, code, locale);
      props.onSignedIn();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status !== 429 && e.status < 500
          ? t.signIn.badCode
          : errorText(e, t),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.brand}>{t.appTitle}</Text>
      <Heading>{t.signIn.title}</Heading>
      {!contact ? (
        <>
          <Text style={styles.text}>{t.signIn.subtitle}</Text>
          <TextInput
            accessibilityLabel={t.signIn.contact}
            placeholder={t.signIn.contact}
            placeholderTextColor={colors.placeholder}
            value={input}
            onChangeText={setInput}
            onSubmitEditing={send}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            inputMode="email"
            style={styles.input}
          />
          {error ? <ErrorText>{error}</ErrorText> : null}
          <Button label={t.signIn.sendCode} onPress={send} busy={busy} disabled={!input.trim()} />
        </>
      ) : (
        <>
          <Text style={styles.text}>{sentText}</Text>
          <TextInput
            accessibilityLabel={t.signIn.code}
            placeholder="000000"
            placeholderTextColor={colors.line}
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            onSubmitEditing={confirm}
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            inputMode="numeric"
            maxLength={6}
            style={[styles.input, styles.code]}
          />
          {error ? <ErrorText>{error}</ErrorText> : null}
          <Button
            label={t.signIn.confirm}
            onPress={confirm}
            busy={busy}
            disabled={code.length !== 6}
          />
          <Button
            kind="link"
            label={t.signIn.otherContact}
            onPress={() => {
              setContact(null);
              setError('');
            }}
          />
        </>
      )}
      <View style={styles.languages} accessibilityLabel={t.language}>
        {LOCALES.map((l) => (
          <Text
            key={l}
            accessibilityRole="button"
            aria-pressed={l === locale}
            onPress={() => props.onLocale(l)}
            style={[styles.language, l === locale && styles.languageActive]}
          >
            {LANGUAGE_NAMES[l]}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, gap: 16, justifyContent: 'center', maxWidth: 480 },
  brand: { color: colors.accent, fontSize: 14, fontWeight: '700', letterSpacing: 2 },
  text: { color: colors.muted, fontSize: 16, lineHeight: 22 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 17,
    color: colors.ink,
  },
  code: { fontSize: 28, letterSpacing: 8, textAlign: 'center' },
  languages: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 24 },
  language: { color: colors.muted, fontSize: 14, paddingVertical: 6 },
  languageActive: { color: colors.ink, fontWeight: '700', textDecorationLine: 'underline' },
});
