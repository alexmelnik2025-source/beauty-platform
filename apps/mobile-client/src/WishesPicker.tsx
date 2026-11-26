import { memo, useCallback, useLayoutEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { WishField } from './errors';
import { FieldGroup } from './FormFeedback';
import type { Dictionary } from './i18n';
import { colors, FieldInput, Pressable } from './ui';
import {
  DRINK_ICON,
  drinkChoices,
  MOOD_ICON,
  MOODS,
  NOTE_MAX,
  type VisitWishes,
  type WishQuestions,
} from './wishes';

/**
 * Task 80: the client's wishes — one tap per answer (a second tap clears it) and a short
 * note. Shown on the code step of the booking and in the visit card.
 */
export function WishesPicker(props: {
  t: Dictionary;
  questions: WishQuestions;
  value: VisitWishes;
  invalid?: WishField;
  onChange: (value: VisitWishes) => void;
}) {
  const { t, questions, value, onChange, invalid } = props;
  const w = t.wishStep;
  const latest = useRef({ value, onChange });
  useLayoutEffect(() => {
    latest.current = { value, onChange };
  }, [value, onChange]);
  const toggle = useCallback(
    <K extends 'mood' | 'drink'>(field: K, choice: NonNullable<VisitWishes[K]>) => {
      const { value, onChange } = latest.current;
      onChange({ ...value, [field]: value[field] === choice ? null : choice });
    },
    [],
  );
  const drinks = drinkChoices(questions);
  return (
    <View role="region" style={styles.box} accessibilityLabel={w.title}>
      <Text role="heading" aria-level={3} style={styles.title}>
        {w.title}
      </Text>
      {questions.mood ? (
        <View role="group" style={styles.group} accessibilityLabel={w.moodQ}>
          <Text style={styles.question}>{w.moodQ}</Text>
          <FieldGroup error={invalid === 'mood' ? w.badChoice : undefined}>
            <View style={styles.chips}>
              {MOODS.map((m) => (
                <WishChoice
                  field="mood"
                  choice={m}
                  toggle={toggle}
                  key={m}
                  label={`${MOOD_ICON[m]} ${w.mood[m]}`}
                  pressed={value.mood === m}
                />
              ))}
            </View>
          </FieldGroup>
        </View>
      ) : null}
      {drinks.length > 0 ? (
        <View role="group" style={styles.group} accessibilityLabel={w.drinkQ}>
          <Text style={styles.question}>{w.drinkQ}</Text>
          <FieldGroup error={invalid === 'drink' ? w.badChoice : undefined}>
            <View style={styles.chips}>
              {drinks.map((d) => (
                <WishChoice
                  field="drink"
                  choice={d}
                  toggle={toggle}
                  key={d}
                  label={`${DRINK_ICON[d]} ${w.drink[d]}`}
                  pressed={value.drink === d}
                />
              ))}
            </View>
          </FieldGroup>
        </View>
      ) : null}
      {questions.note ? (
        <View style={styles.group}>
          <Text style={styles.question}>{w.noteQ}</Text>
          <FieldInput
            error={invalid === 'note' ? w.badNote : undefined}
            accessibilityLabel={w.noteQ}
            placeholder={w.notePlaceholder}
            placeholderTextColor={colors.muted}
            value={value.note ?? ''}
            onChangeText={(text) => onChange({ ...value, note: text || null })}
            maxLength={NOTE_MAX}
            multiline
            style={styles.input}
          />
          <Text style={styles.count}>
            {(value.note ?? '').length} / {NOTE_MAX}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const WishChoice = memo(function WishChoice(props: {
  field: 'mood' | 'drink';
  choice: NonNullable<VisitWishes['mood' | 'drink']>;
  label: string;
  pressed: boolean;
  toggle: (field: 'mood' | 'drink', choice: NonNullable<VisitWishes['mood' | 'drink']>) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.pressed }}
      aria-pressed={props.pressed}
      onPress={() => props.toggle(props.field, props.choice)}
      style={[styles.choice, props.pressed && styles.choiceOn]}
    >
      <Text style={[styles.choiceText, props.pressed && styles.choiceTextOn]}>{props.label}</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  box: {
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  title: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  group: { gap: 8 },
  question: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: {
    maxWidth: '100%',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  choiceOn: { borderColor: colors.ink, backgroundColor: colors.ink },
  choiceText: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  choiceTextOn: { color: colors.card },
  input: {
    minHeight: 56,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    padding: 10,
    fontSize: 15,
    color: colors.ink,
  },
  count: { color: colors.muted, fontSize: 12, alignSelf: 'flex-end' },
});
