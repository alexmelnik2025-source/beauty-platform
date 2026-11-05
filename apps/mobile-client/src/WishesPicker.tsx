import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { Dictionary } from './i18n';
import { Chip, colors } from './ui';
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
  onChange: (value: VisitWishes) => void;
}) {
  const { t, questions, value, onChange } = props;
  const w = t.wishStep;
  const drinks = drinkChoices(questions);
  return (
    <View style={styles.box} accessibilityLabel={w.title}>
      <Text role="heading" aria-level={3} style={styles.title}>
        {w.title}
      </Text>
      {questions.mood ? (
        <View style={styles.group} accessibilityLabel={w.moodQ}>
          <Text style={styles.question}>{w.moodQ}</Text>
          <View style={styles.chips}>
            {MOODS.map((m) => (
              <Chip
                key={m}
                label={`${MOOD_ICON[m]} ${w.mood[m]}`}
                pressed={value.mood === m}
                onPress={() => onChange({ ...value, mood: value.mood === m ? null : m })}
              />
            ))}
          </View>
        </View>
      ) : null}
      {drinks.length > 0 ? (
        <View style={styles.group} accessibilityLabel={w.drinkQ}>
          <Text style={styles.question}>{w.drinkQ}</Text>
          <View style={styles.chips}>
            {drinks.map((d) => (
              <Chip
                key={d}
                label={`${DRINK_ICON[d]} ${w.drink[d]}`}
                pressed={value.drink === d}
                onPress={() => onChange({ ...value, drink: value.drink === d ? null : d })}
              />
            ))}
          </View>
        </View>
      ) : null}
      {questions.note ? (
        <View style={styles.group}>
          <Text style={styles.question}>{w.noteQ}</Text>
          <TextInput
            accessibilityLabel={w.noteQ}
            placeholder={w.notePlaceholder}
            placeholderTextColor={colors.placeholder}
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
