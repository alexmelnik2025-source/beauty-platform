import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

/** Small shared building blocks and colours of the client app (same look as the business app). */
export const colors = {
  background: '#f6f4f0',
  card: '#ffffff',
  ink: '#1d1d1b',
  muted: '#6b6760',
  line: '#e4dfd6',
  accent: '#1d1d1b',
  gold: '#c8a46a',
  danger: '#b3261e',
};

export function Button(props: {
  label: string;
  /** What a screen reader says when the visible label is a symbol (‹ ›). */
  a11yLabel?: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'link';
  disabled?: boolean;
  busy?: boolean;
}) {
  const kind = props.kind ?? 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.a11yLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled || props.busy }}
      disabled={props.disabled || props.busy}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'secondary' && styles.secondary,
        kind === 'link' && styles.link,
        (props.disabled || pressed) && { opacity: 0.6 },
      ]}
    >
      {props.busy ? (
        <ActivityIndicator color={kind === 'primary' ? '#fff' : colors.ink} />
      ) : (
        <Text style={[styles.buttonText, kind !== 'primary' && { color: colors.ink }]}>
          {props.label}
        </Text>
      )}
    </Pressable>
  );
}

/** A filter button that stays pressed (language of the catalogue). */
export function Chip(props: { label: string; pressed: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      aria-pressed={props.pressed}
      onPress={props.onPress}
      style={[styles.chip, props.pressed && styles.chipOn]}
    >
      <Text style={[styles.chipText, props.pressed && { color: '#fff' }]}>{props.label}</Text>
    </Pressable>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return (
    <Text role="heading" aria-level={1} style={styles.heading}>
      {children}
    </Text>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <Text role="alert" style={styles.error}>
      {children}
    </Text>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  link: { backgroundColor: 'transparent', paddingHorizontal: 8 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
    minHeight: 36,
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  heading: { fontSize: 26, fontWeight: '700', color: colors.ink },
  error: { color: colors.danger, fontSize: 15 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 4,
  },
});
