import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Dictionary } from '../i18n';
import { PAYMENT_METHODS, toggleMethod, type PaymentMethod } from '../payment';
import { colors } from '../ui';

/** Task 227: Gotówka / Karta / BLIK / Przelew / Inna — only a mark for the report and the till. */
export function PaymentMethodPicker({
  t,
  value,
  onChange,
  disabled,
}: {
  t: Dictionary;
  value: PaymentMethod | null;
  onChange: (method: PaymentMethod | null) => void;
  disabled?: boolean;
}) {
  const v = t.visit;
  return (
    <View style={styles.box}>
      <Text style={styles.label}>{v.paymentMethod}</Text>
      <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={v.paymentMethod}>
        {PAYMENT_METHODS.map((method) => (
          <Pressable
            key={method}
            accessibilityRole="radio"
            accessibilityState={{ checked: value === method, disabled }}
            disabled={disabled}
            onPress={() => onChange(toggleMethod(value, method))}
            style={[styles.chip, value === method && styles.chipOn]}
          >
            <Text style={[styles.chipText, value === method && styles.chipTextOn]}>
              {v.paymentMethods[method]}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 6 },
  label: { color: colors.muted, fontSize: 13 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { color: colors.ink, fontSize: 14 },
  chipTextOn: { color: '#fff', fontWeight: '600' },
});
