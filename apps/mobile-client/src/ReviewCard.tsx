import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ApiError, type ClientApi, type Locale, type VisitReview } from './api';
import { formFailure, isNetworkError, validationField, type FormFailure } from './errors';
import { FieldGroup, FormFeedback } from './FormFeedback';
import { fill, type Dictionary } from './i18n';
import { Button, colors, FieldInput, Pressable } from './ui';

const TEXT_MAX = 1000;

/**
 * Task 165b: "Twoja opinia" in the visit card — after a visit that took place the client gives
 * 1–5 stars to the specialist and a few words, and may change them for 30 days. Nothing is
 * shown when there is nothing to write and nothing written.
 */
export function ReviewCard(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  visitId: string;
  staffName: string;
}) {
  const { api, t, locale, visitId } = props;
  const r = t.review;
  const [state, setState] = useState<VisitReview | null>(null);
  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [field, setField] = useState<'rating' | 'text'>();
  const [loadAttempt, retryLoad] = useState(0);
  const [thanks, setThanks] = useState(false);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    let live = true;
    api
      .visitReview(visitId)
      .then((res) => {
        if (!live) return;
        setState(res);
        setEditing(res.canReview && !res.review);
        setRating(res.review?.rating ?? 0);
        setText(res.review?.text ?? '');
      })
      .catch((error: unknown) => {
        if (live && isNetworkError(error)) {
          setFailure(
            formFailure(error, tRef.current, () => {
              setFailure(null);
              retryLoad((attempt) => attempt + 1);
            }),
          );
        }
      });
    return () => {
      live = false;
    };
  }, [api, visitId, loadAttempt]);

  if (!state) return <FormFeedback failure={failure} retryLabel={t.retry} />;
  if (!state.canReview && !state.review) return null;

  async function send() {
    if (busy) return;
    if (rating === 0) return setField('rating');
    setBusy(true);
    setFailure(null);
    setField(undefined);
    try {
      const res = await api.writeReview(visitId, rating, text);
      setState(res);
      setEditing(false);
      setThanks(true);
    } catch (e) {
      const invalid = validationField(e, ['rating', 'text']);
      if (invalid) setField(invalid);
      else if (e instanceof ApiError && e.code === 'REVIEW_NOT_POSSIBLE') {
        setFailure({ message: r.notPossible });
      } else setFailure(formFailure(e, tRef.current, () => void send()));
    } finally {
      setBusy(false);
    }
  }

  const until = state.reviewUntil
    ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(
        new Date(state.reviewUntil),
      )
    : null;

  return (
    <View style={styles.box} aria-label={r.title} role="region">
      <Text style={styles.title}>{r.title}</Text>
      {thanks ? (
        <Text role="status" style={styles.thanks}>
          {r.thanks}
        </Text>
      ) : null}
      {editing ? (
        <>
          <Text style={styles.ask}>{fill(r.ask, { staff: props.staffName })}</Text>
          <FieldGroup error={field === 'rating' ? r.badRating : undefined}>
            <View
              style={styles.stars}
              role="radiogroup"
              aria-label={r.rating}
              aria-invalid={field === 'rating'}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <Pressable
                  key={n}
                  role="radio"
                  aria-checked={rating === n}
                  accessibilityLabel={fill(r.outOf, { n: String(n) })}
                  disabled={busy}
                  onPress={() => {
                    setRating(n);
                    setFailure(null);
                    if (field === 'rating') setField(undefined);
                  }}
                  style={styles.starButton}
                >
                  <Text style={[styles.star, n <= rating && styles.starOn]}>
                    {n <= rating ? '★' : '☆'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </FieldGroup>
          <FieldInput
            error={field === 'text' ? r.badText : undefined}
            editable={!busy}
            accessibilityLabel={r.text}
            placeholder={r.text}
            placeholderTextColor={colors.placeholder}
            value={text}
            onChangeText={(value) => {
              setText(value);
              setFailure(null);
              if (field === 'text') setField(undefined);
            }}
            maxLength={TEXT_MAX}
            multiline
            style={styles.input}
          />
          <FormFeedback failure={failure} retryLabel={t.retry} busy={busy} />
          <Button label={r.send} busy={busy} onPress={() => void send()} />
        </>
      ) : state.review ? (
        <>
          <Text style={styles.given} aria-label={fill(r.outOf, { n: String(state.review.rating) })}>
            {'★'.repeat(state.review.rating)}
            <Text style={styles.off}>{'★'.repeat(5 - state.review.rating)}</Text>
          </Text>
          {state.review.text ? <Text style={styles.text}>{state.review.text}</Text> : null}
          {state.review.reply ? (
            <View
              style={styles.reply}
              accessible
              accessibilityLabel={`${r.salonReply}: ${state.review.reply}`}
            >
              <Text style={styles.replyTitle}>{r.salonReply}</Text>
              <Text style={styles.text}>{state.review.reply}</Text>
            </View>
          ) : null}
          {state.canReview ? (
            <>
              {until ? (
                <Text style={styles.muted}>{fill(r.changeUntil, { date: until })}</Text>
              ) : null}
              <Button kind="secondary" label={r.change} onPress={() => setEditing(true)} />
            </>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: 10,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  title: { fontSize: 18, fontWeight: '700', color: colors.ink },
  ask: { fontSize: 15, color: colors.ink },
  thanks: { color: '#1e6b3a', fontSize: 15, fontWeight: '600' },
  stars: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  starButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  star: { fontSize: 32, color: colors.muted },
  starOn: { color: colors.accent },
  given: { fontSize: 22, color: colors.accent, letterSpacing: 2 },
  off: { color: colors.line },
  text: { fontSize: 15, color: colors.ink, lineHeight: 21 },
  muted: { color: colors.muted, fontSize: 13 },
  // Task 211: the salon's public answer under the client's review.
  reply: {
    gap: 2,
    paddingLeft: 12,
    paddingVertical: 4,
    borderLeftWidth: 2,
    borderLeftColor: colors.ink,
  },
  replyTitle: { fontSize: 13, fontWeight: '700', color: colors.ink },
  input: {
    minHeight: 80,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    padding: 10,
    fontSize: 15,
    color: colors.ink,
    textAlignVertical: 'top',
  },
});
