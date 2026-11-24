import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ApiError,
  parseContact,
  type BusinessApi,
  type Contact,
  type Locale,
  type LoginCodeSent,
} from '../api';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { LanguagePicker } from './LanguagePicker';
import { Button, colors, Heading } from '../ui';

type Challenge = { contact: Contact; channel: LoginCodeSent['channel'] };
type SignInError = { field: 'badContact' | 'badCode' } | { request: unknown };

function deliveryMessage({ contact, channel }: Challenge, t: Dictionary) {
  if ('email' in contact) return fill(t.signIn.sentEmail, { to: contact.email });
  return channel === 'sms'
    ? fill(t.signIn.sentSms, { to: contact.phone })
    : t.signIn.sentToInviteEmail;
}

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
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<SignInError | null>(null);
  const [pending, setPending] = useState<'send' | 'confirm' | null>(null);
  const inFlight = useRef(false);
  const busy = pending !== null;

  async function send() {
    if (inFlight.current) return;
    const parsed = challenge?.contact ?? parseContact(input);
    if (!parsed) return setError({ field: 'badContact' });
    inFlight.current = true;
    setPending('send');
    setError(null);
    try {
      const sent = await api.requestCode(parsed, locale);
      setChallenge({ contact: parsed, channel: sent.channel });
      setCode('');
    } catch (e) {
      setError({ request: e });
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  async function confirm() {
    if (inFlight.current || !challenge || code.length !== 6) return;
    inFlight.current = true;
    setPending('confirm');
    setError(null);
    try {
      await api.verifyCode(challenge.contact, code, locale);
      props.onSignedIn();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status !== 429 && e.status < 500
          ? { field: 'badCode' }
          : { request: e },
      );
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  const invalid = error !== null && 'field' in error;
  const feedback = error ? (
    <Text nativeID="signin-error" role="alert" style={styles.error}>
      ! {invalid ? t.signIn[error.field] : errorText(error.request, t)}
    </Text>
  ) : null;

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Text style={styles.brand}>{t.appTitle}</Text>
      <Heading>{t.signIn.title}</Heading>
      {!challenge ? (
        <>
          <Text style={styles.text}>{t.signIn.subtitle}</Text>
          <View style={styles.field}>
            <TextInput
              accessibilityLabel={t.signIn.contact}
              editable={!busy}
              aria-invalid={invalid}
              aria-describedby={error ? 'signin-error' : undefined}
              placeholder={t.signIn.contact}
              placeholderTextColor={colors.placeholder}
              value={input}
              onChangeText={(value) => {
                setInput(value);
                setError(null);
              }}
              onSubmitEditing={send}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              inputMode="email"
              style={[styles.input, invalid && styles.invalid]}
            />
            {feedback}
          </View>
          <Button label={t.signIn.sendCode} onPress={send} busy={busy} disabled={!input.trim()} />
        </>
      ) : (
        <>
          <Text nativeID="signin-delivery" accessibilityLiveRegion="polite" style={styles.text}>
            {deliveryMessage(challenge, t)}
          </Text>
          <View style={styles.field}>
            <TextInput
              accessibilityLabel={t.signIn.code}
              editable={!busy}
              aria-invalid={invalid}
              aria-describedby={error ? 'signin-error' : 'signin-delivery'}
              placeholder="000000"
              placeholderTextColor={colors.line}
              value={code}
              onChangeText={(v) => {
                setCode(v.replace(/\D/g, '').slice(0, 6));
                setError(null);
              }}
              onSubmitEditing={confirm}
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              inputMode="numeric"
              maxLength={6}
              style={[styles.input, styles.code, invalid && styles.invalid]}
            />
            {feedback}
          </View>
          <Button
            label={t.signIn.confirm}
            onPress={confirm}
            busy={pending === 'confirm'}
            disabled={busy || code.length !== 6}
          />
          <Button
            kind="link"
            label={t.signIn.sendCode}
            onPress={send}
            busy={pending === 'send'}
            disabled={busy}
          />
          <Button
            kind="link"
            disabled={busy}
            label={t.signIn.otherContact}
            onPress={() => {
              setChallenge(null);
              setError(null);
            }}
          />
        </>
      )}
      <LanguagePicker t={t} locale={locale} onLocale={props.onLocale} disabled={busy} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, padding: 24, gap: 16, justifyContent: 'center', maxWidth: 480 },
  brand: { color: colors.accent, fontSize: 14, fontWeight: '700', letterSpacing: 2 },
  text: { color: colors.muted, fontSize: 16, lineHeight: 22 },
  field: { gap: 4 },
  input: {
    minHeight: 44,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 17,
    color: colors.ink,
  },
  error: { color: colors.danger, fontSize: 15 },
  invalid: { borderColor: colors.danger },
  code: { fontSize: 28, letterSpacing: 8, textAlign: 'center' },
});
