import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentRef,
  type ComponentPropsWithRef,
} from 'react';
import {
  AccessibilityInfo,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ApiError, parseEmail, type ClientApi, type ClientPerson, type Locale } from '../api';
import { errorText, formFailure, isCodeError, validationField } from '../errors';
import { FormFeedback } from '../FormFeedback';
import { fill, type Dictionary } from '../i18n';
import { LanguageRow } from '../LanguageRow';
import type { RecentSalon } from '../recent';
import { RecentSalons } from './RecentSalons';
import { Button, colors, ErrorText, Heading } from '../ui';

function SignInField({
  error,
  style,
  ...props
}: ComponentPropsWithRef<typeof TextInput> & {
  error?: string;
}) {
  const errorId = useId();
  return (
    <View style={styles.field}>
      <TextInput
        {...props}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        accessibilityHint={error}
        style={[styles.input, style, error && styles.invalid]}
      />
      {error ? (
        <View nativeID={errorId}>
          <ErrorText>! {error}</ErrorText>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Sign-in without a password or an account: the email the client books with → 6-digit code.
 * The same visits as on the web ("Moje wizyty"), found by that email in every salon.
 */
type SignInProps = {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  onLocale: (locale: Locale) => void;
  /** Opens the catalogue of salons (no sign-in needed). */
  /** Task 180b: opens the catalogue, with what the client typed in "Czego szukasz?". */
  onFindSalon: (query?: string) => void;
  /** Task 370: opens the catalogue with "Otwarte teraz" on. */
  onOpenNow: () => void;
  /** Task 379: the catalogue with the best rated salons first. */
  onBestRated: () => void;
  /** Task Q3: "Sklep" — a quiet link under "Znajdź salon". */
  onShop: () => void;
  /** Task 402: "Ostatnio oglądane" — the salons opened last on this device. */
  recent?: RecentSalon[];
  onOpenRecent?: (salon: RecentSalon) => void;
  /** Task 414: "Wyczyść listę". */
  onClearRecent?: () => void;
  onSignedIn: (person: ClientPerson) => void;
  /** The email the client just booked with (from the booking in the app). */
  initialEmail?: string;
};

const emptyRecent: RecentSalon[] = [];
const noop = () => {};

export function SignInScreen(props: SignInProps) {
  const { api, t, locale } = props;
  const [what, setWhat] = useState('');
  // Task 370: how many salons are open right now; the button is there only when some are.
  const [openNowCount, setOpenNowCount] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .directory({ page: 1, pageSize: 1 })
      .then((res) => {
        if (alive) setOpenNowCount(res.openNowCount);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Text style={styles.brand}>{t.appTitle.toUpperCase()}</Text>
      {/* Task 180b: the client looks for a salon first; signing in is only needed for "Moje wizyty". */}
      <View role="group" aria-label={t.catalog.searchGo} style={styles.search}>
        <Text style={styles.text}>{t.catalog.startLead}</Text>
        <TextInput
          accessibilityLabel={t.catalog.startSearch}
          placeholder={t.catalog.search}
          placeholderTextColor={colors.placeholder}
          value={what}
          onChangeText={setWhat}
          onSubmitEditing={() => props.onFindSalon(what.trim())}
          autoCorrect={false}
          inputMode="search"
          style={styles.input}
        />
        <Button label={t.catalog.searchGo} onPress={() => props.onFindSalon(what.trim())} />
        {openNowCount > 0 ? (
          <Button
            kind="secondary"
            label={`● ${t.catalog.openNow} (${openNowCount})`}
            a11yLabel={`${t.catalog.openNow} (${openNowCount})`}
            onPress={props.onOpenNow}
          />
        ) : null}
        {/* Task 379: the catalogue with the best rated salons first. */}
        <Button kind="secondary" label={t.catalog.bestRated} onPress={props.onBestRated} />
      </View>
      <RecentSalons
        t={t}
        recent={props.recent ?? emptyRecent}
        onOpen={props.onOpenRecent ?? noop}
        onClear={props.onClearRecent ?? noop}
      />
      <SignInForm
        api={api}
        t={t}
        locale={locale}
        initialEmail={props.initialEmail}
        onSignedIn={props.onSignedIn}
      />
      <Button kind="secondary" label={t.catalog.title} onPress={() => props.onFindSalon()} />
      <Button kind="link" label={t.shop.entry} onPress={props.onShop} />
      <LanguageRow label={t.language} locale={locale} onLocale={props.onLocale} />
    </ScrollView>
  );
}

const SignInForm = memo(function SignInForm(
  props: Pick<SignInProps, 'api' | 't' | 'locale' | 'initialEmail' | 'onSignedIn'>,
) {
  const { api, t, locale } = props;
  const [input, setInput] = useState(props.initialEmail ?? '');
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const field = useRef<ComponentRef<typeof TextInput>>(null);
  const [fieldIssue, setFieldIssue] = useState<{
    reason: 'badEmail' | 'badCode' | ApiError;
  } | null>(null);
  const reason = fieldIssue?.reason;
  const fieldError = typeof reason === 'string' ? t.signIn[reason] : reason && errorText(reason, t);
  const [requestIssue, setRequestIssue] = useState<{
    error: unknown;
    action: 'send' | 'confirm';
  } | null>(null);
  const submitting = useRef(false);
  const [activeRequest, setActiveRequest] = useState<'send' | 'confirm' | null>(null);
  const busy = activeRequest !== null;

  useEffect(() => {
    if (fieldIssue && !busy && field.current) {
      field.current.focus();
      if (Platform.OS !== 'web') AccessibilityInfo.sendAccessibilityEvent(field.current, 'focus');
    }
  }, [fieldIssue, busy]);

  async function send(email = parseEmail(input)) {
    if (submitting.current) return;
    setFieldIssue(null);
    setRequestIssue(null);
    if (!email) return setFieldIssue({ reason: 'badEmail' });
    submitting.current = true;
    setActiveRequest('send');
    try {
      await api.requestCode(email, locale);
      setSentTo(email);
      setCode('');
    } catch (e) {
      if (!sentTo && validationField(e, ['email'])) setFieldIssue({ reason: 'badEmail' });
      else setRequestIssue({ error: e, action: 'send' });
    } finally {
      submitting.current = false;
      setActiveRequest(null);
    }
  }

  async function confirm() {
    if (submitting.current) return;
    if (code.length !== 6) return setFieldIssue({ reason: 'badCode' });
    setFieldIssue(null);
    submitting.current = true;
    setActiveRequest('confirm');
    setRequestIssue(null);
    try {
      props.onSignedIn(await api.verifyCode(sentTo, code, locale));
    } catch (e) {
      if (e instanceof ApiError && isCodeError(e)) setFieldIssue({ reason: e });
      else if (validationField(e, ['code'])) setFieldIssue({ reason: 'badCode' });
      else setRequestIssue({ error: e, action: 'confirm' });
      submitting.current = false;
      setActiveRequest(null);
    }
  }

  const failure =
    requestIssue &&
    formFailure(requestIssue.error, t, () => {
      if (requestIssue.action === 'send') void send(sentTo || parseEmail(input));
      else void confirm();
    });

  return (
    <>
      <Heading>{t.signIn.title}</Heading>
      {!sentTo ? (
        <>
          <Text style={styles.text}>{t.signIn.subtitle}</Text>
          <SignInField
            key="email"
            ref={field}
            error={fieldError}
            accessibilityLabel={t.signIn.email}
            placeholder={t.signIn.email}
            placeholderTextColor={colors.placeholder}
            editable={!busy}
            value={input}
            onChangeText={(value) => {
              setInput(value);
              setRequestIssue(null);
              setFieldIssue(null);
            }}
            onSubmitEditing={() => void send()}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            inputMode="email"
          />
          <FormFeedback failure={failure} retryLabel={t.retry} busy={busy} />
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
          <SignInField
            key="code"
            ref={field}
            error={fieldError}
            accessibilityLabel={t.signIn.code}
            placeholder="000000"
            placeholderTextColor={colors.line}
            editable={!busy}
            value={code}
            onChangeText={(v) => {
              setFieldIssue(null);
              setRequestIssue(null);
              setCode(v.replace(/\D/g, '').slice(0, 6));
            }}
            onSubmitEditing={confirm}
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            inputMode="numeric"
            maxLength={6}
            style={styles.code}
          />
          <FormFeedback failure={failure} retryLabel={t.retry} busy={busy} />
          <Button
            label={t.signIn.confirm}
            onPress={confirm}
            busy={activeRequest === 'confirm'}
            disabled={busy || code.length !== 6}
          />
          <View style={styles.row}>
            <Button
              kind="link"
              label={t.signIn.resend}
              busy={activeRequest === 'send'}
              disabled={busy}
              onPress={() => void send(sentTo)}
            />
            <Button
              kind="link"
              label={t.signIn.otherEmail}
              disabled={busy}
              onPress={() => {
                setSentTo('');
                setFieldIssue(null);
                setRequestIssue(null);
              }}
            />
          </View>
        </>
      )}
    </>
  );
});

const styles = StyleSheet.create({
  search: {
    gap: 10,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  screen: {
    flexGrow: 1,
    width: '100%',
    padding: 24,
    gap: 16,
    justifyContent: 'center',
    maxWidth: 480,
  },
  brand: { color: colors.accent, fontSize: 14, fontWeight: '700', letterSpacing: 2 },
  text: { color: colors.muted, fontSize: 16, lineHeight: 22 },
  field: { gap: 4 },
  invalid: { borderColor: colors.danger },
  input: {
    minHeight: 44,
    minWidth: 0,
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
