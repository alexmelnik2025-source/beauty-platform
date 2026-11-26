import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable as NativePressable,
  type PressableProps,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

/** Small shared building blocks and colours of the client app (same look as the business app). */
export const colors = {
  /**
   * Task 190: strict black and white (GESTALT): light grey page, white cards, black text and
   * buttons, thin grey lines; no beige or brown. `accent` is the salon's accent colour (black
   * for now); `placeholder` and `soft` are the greys of hints and quiet backgrounds.
   */
  background: '#f4f4f2',
  card: '#ffffff',
  ink: '#111111',
  muted: '#666666',
  line: '#e2e2e2',
  accent: '#111111',
  placeholder: '#9a9a9a',
  soft: '#ececec',
  danger: '#b3261e',
};

/** Keep the entire control tappable without extending into neighbouring controls. */
export function Pressable({ style, ...props }: PressableProps) {
  return (
    <NativePressable
      {...props}
      style={(state) => [styles.touchTarget, typeof style === 'function' ? style(state) : style]}
    />
  );
}

export const switchTouchTarget = Platform.select({
  web: { height: 44 },
  default: { minHeight: 44, minWidth: 44 },
});

export function Button(props: {
  label: string;
  /** What a screen reader says when the visible label is a symbol (‹ ›). */
  a11yLabel?: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'link';
  disabled?: boolean;
  busy?: boolean;
  /** For a button that shows or hides a section: a screen reader says "expanded" / "collapsed". */
  expanded?: boolean;
}) {
  const kind = props.kind ?? 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.a11yLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled || props.busy, expanded: props.expanded }}
      aria-expanded={props.expanded}
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
export function Chip(props: {
  label: string;
  /** What a screen reader says when the label is a flag and a code ("🇺🇦 UA (12)"). */
  a11yLabel?: string;
  pressed: boolean;
  compact?: boolean;
  expanded?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.a11yLabel ?? props.label}
      aria-pressed={props.pressed}
      aria-expanded={props.expanded}
      onPress={props.onPress}
      style={[styles.chip, props.compact && styles.compactChip, props.pressed && styles.chipOn]}
    >
      <Text
        style={[
          styles.chipText,
          props.compact && styles.compactChipText,
          props.pressed && { color: '#fff' },
        ]}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** Input feedback stays with the field that the client can correct. */
export function FieldInput({ error, style, ...props }: TextInputProps & { error?: string }) {
  return (
    <View style={{ gap: 4 }}>
      <TextInput
        {...props}
        aria-invalid={Boolean(error)}
        style={[style, error && styles.invalid]}
      />
      {error ? <ErrorText>! {error}</ErrorText> : null}
    </View>
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

export function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Button
        kind="link"
        label={`${label} ${expanded ? '▾' : '▸'}`}
        a11yLabel={label}
        expanded={expanded}
        onPress={() => setExpanded((open) => !open)}
      />
      <View style={{ gap: 8, display: expanded ? 'flex' : 'none' }}>{children}</View>
    </View>
  );
}

export function LoadingCards({ label }: { label: string }) {
  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityState={{ busy: true }}
      style={{ gap: 8 }}
    >
      {[0, 1, 2].map((row) => (
        <Card key={row}>
          <View
            accessible={false}
            style={{ height: 14, width: '45%', borderRadius: 6, backgroundColor: colors.soft }}
          />
          <View
            accessible={false}
            style={{ height: 10, width: '70%', borderRadius: 5, backgroundColor: colors.soft }}
          />
        </Card>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  touchTarget: { minWidth: 44, minHeight: 44 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    maxWidth: '100%',
  },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  link: { backgroundColor: 'transparent', paddingHorizontal: 8 },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    maxWidth: '100%',
    textAlign: 'center',
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
    maxWidth: '100%',
    justifyContent: 'center',
  },
  compactChip: { paddingHorizontal: 7, paddingVertical: 4 },
  compactChipText: { fontSize: 12 },
  invalid: { borderColor: colors.danger, borderWidth: 1 },
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
