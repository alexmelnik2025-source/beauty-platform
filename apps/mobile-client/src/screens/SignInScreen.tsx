import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { parseEmail, type ClientApi, type ClientPerson, type Locale } from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { LanguageRow } from '../LanguageRow';
import { Button, colors, ErrorText, Heading } from '../ui';

/**
 * Sign-in without a password or an account: the email the client books with → 6-digit code.
 * The same visits as on the web ("Moje wizyty"), found by that email in every salon.
 */
export function SignInScreen(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  onLocale: (locale: Locale) => void;
  /** Opens the catalogue of salons (no sign-in needed). */
  onFindSalon: () => void;
  onSignedIn: (person: ClientPerson) => void;
  /** The email the client just booked with (from the booking in the app). */
  initialEmail?: string;
}) {
  const { api, t, locale } = props;
  const [input, setInput] = useState(props.initialEmail ?? '');
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(email = parseEmail(input)) {
    if (!email) return setError(t.signIn.badEmail);
    setBusy(true);
    setError('');
    try {
      await api.requestCode(email, locale);
      setSentTo(email);
      setCode('');
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (code.length !== 6) return;
    setBusy(true);
    setError('');
    try {
      props.onSignedIn(await api.verifyCode(sentTo, code, locale));
    } catch (e) {
      setError(errorText(e, t));
      setBusy(false);
    }
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.brand}>{t.appTitle.toUpperCase()}</Text>
      <Heading>{t.signIn.title}</Heading>
      {!sentTo ? (
        <>
          <Text style={styles.text}>{t.signIn.subtitle}</Text>
          <TextInput
            accessibilityLabel={t.signIn.email}
            placeholder={t.signIn.email}
            placeholderTextColor={colors.placeholder}
            value={input}
            onChangeText={setInput}
            onSubmitEditing={() => void send()}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            inputMode="email"
            style={styles.input}
          />
          {error ? <ErrorText>{error}</ErrorText> : null}
          <Button
            label={t.signIn.sendCode}
            onPress={() => void send()}
            busy={busy}
            disabled={!input.trim()}
          />
        </>
      ) : (
        <>
          <Text style={styles.text}>{fill(t.signIn.sent, { email: sentTo })}</Text>
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
          <View style={styles.row}>
            <Button
              kind="link"
              label={t.signIn.resend}
              disabled={busy}
              onPress={() => void send(sentTo)}
            />
            <Button
              kind="link"
              label={t.signIn.otherEmail}
              disabled={busy}
              onPress={() => {
                setSentTo('');
                setError('');
              }}
            />
          </View>
        </>
      )}
      <Button kind="secondary" label={t.catalog.title} onPress={props.onFindSalon} />
      <LanguageRow label={t.language} locale={locale} onLocale={props.onLocale} />
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
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
});
