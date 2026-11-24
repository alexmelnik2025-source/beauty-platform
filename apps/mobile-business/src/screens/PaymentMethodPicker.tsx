import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Dictionary } from '../i18n';
import { PAYMENT_METHODS, toggleMethod, type PaymentMethod } from '../payment';
import { Button, colors, Pressable } from '../ui';

/** Task 227: Gotówka / Karta / BLIK / Przelew / Inna — only a mark for the report and the till. */
export function PaymentMethodPicker({
  t,
  value,
  onChange,
  disabled,
  label,
}: {
  t: Dictionary;
  /** Task 547: another title (default "Sposób płatności"). */
  label?: string;
  value: PaymentMethod | null;
  onChange: (method: PaymentMethod | null) => void;
  disabled?: boolean;
}) {
  const v = t.visit;
  const title = label ?? v.paymentMethod;
  // Unpaid visits keep the selection in the parent form. On a paid visit
  // the parent only changes value when the server confirms the update.
  const [draft, setDraft] = useState<{ method: PaymentMethod | null } | null>(null);
  const changing = useRef(false);
  const selected = draft ? draft.method : value;
  useEffect(() => {
    if (!disabled) changing.current = false;
    if (draft && draft.method === value) setDraft(null);
  }, [disabled, draft, value]);

  function choose(method: PaymentMethod | null) {
    if (disabled || changing.current) return;
    changing.current = true;
    setDraft({ method });
    onChange(method);
  }
  return (
    <View style={styles.box}>
      <Text style={styles.label}>{title}</Text>
      <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={title}>
        {PAYMENT_METHODS.map((method) => (
          <Pressable
            accessibilityLabel={v.paymentMethods[method]}
            key={method}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected === method, disabled }}
            aria-checked={selected === method}
            disabled={disabled}
            onPress={() => choose(toggleMethod(selected, method))}
            style={[styles.chip, selected === method && styles.chipOn]}
          >
            <Text style={[styles.chipText, selected === method && styles.chipTextOn]}>
              {v.paymentMethods[method]}
            </Text>
          </Pressable>
        ))}
      </View>
      {draft && draft.method !== value && !disabled ? (
        <View style={styles.box}>
          <Text role="status" style={styles.label}>
            {t.navigation.unsaved}
          </Text>
          <Button kind="secondary" label={t.day.tillSave} onPress={() => choose(draft.method)} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 6 },
  label: { color: colors.muted, fontSize: 13 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    maxWidth: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { color: colors.ink, fontSize: 14, maxWidth: '100%', textAlign: 'center' },
  chipTextOn: { color: '#fff', fontWeight: '600' },
});
