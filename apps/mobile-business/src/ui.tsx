import { useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable as NativePressable,
  type PressableProps,
  StyleSheet,
  Text,
  View,
} from 'react-native';

/** Small shared building blocks and colours of the business app. */
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
  onPress: () => void | Promise<void>;
  kind?: 'primary' | 'secondary' | 'link';
  disabled?: boolean;
  busy?: boolean;
  compact?: boolean;
  expanded?: boolean;
  selected?: boolean;
}) {
  const kind = props.kind ?? 'primary';
  const submitting = useRef(false);

  async function handlePress() {
    if (submitting.current || props.busy || props.disabled) return;
    // The next press can arrive before the parent renders its busy state.
    submitting.current = true;
    try {
      const action = props.onPress();
      // Busy-aware callbacks that return void still need the lock until this event ends.
      if (action !== undefined || props.busy !== undefined) await action;
    } finally {
      submitting.current = false;
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.a11yLabel ?? props.label}
      accessibilityState={{
        busy: props.busy,
        disabled: props.disabled || props.busy,
        expanded: props.expanded,
        selected: props.selected,
      }}
      aria-busy={props.busy}
      aria-expanded={props.expanded}
      aria-selected={props.selected}
      disabled={props.disabled || props.busy}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.button,
        kind === 'secondary' && styles.secondary,
        kind === 'link' && styles.link,
        props.compact && styles.compact,
        props.selected && { backgroundColor: colors.soft },
        (props.disabled || pressed) && { opacity: 0.6 },
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          props.compact && styles.compactText,
          kind !== 'primary' && { color: colors.ink },
          props.busy && { opacity: 0 },
        ]}
      >
        {props.label}
      </Text>
      {props.busy && (
        <ActivityIndicator
          style={StyleSheet.absoluteFill}
          color={kind === 'primary' ? '#fff' : colors.ink}
        />
      )}
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
  compact: { paddingHorizontal: 10, paddingVertical: 7, minHeight: 44 },
  compactText: { fontSize: 14 },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    maxWidth: '100%',
    textAlign: 'center',
  },
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
