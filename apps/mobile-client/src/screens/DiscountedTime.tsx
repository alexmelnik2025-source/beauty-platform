import { StyleSheet, Text } from 'react-native';
import type { Dictionary } from '../i18n';
import { colors, Pressable } from '../ui';

export function DiscountedTime({
  time,
  percent,
  listPrice,
  labels,
  disabled,
  onPress,
}: {
  time: string;
  percent: number;
  listPrice?: string;
  labels: Pick<Dictionary['visit'], 'price' | 'discount'>;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        time,
        listPrice && `${labels.price} ${listPrice}`,
        `${labels.discount} −${percent}%`,
      ]
        .filter(Boolean)
        .join(' · ')}
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={styles.slot}
    >
      <Text style={styles.label}>
        {time} · {`−${percent}%`}
      </Text>
      {listPrice ? <Text style={styles.listPrice}>{listPrice}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  slot: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    maxWidth: '100%',
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { color: colors.ink, fontWeight: '600', fontSize: 14 },
  listPrice: { color: colors.muted, fontSize: 12, textDecorationLine: 'line-through' },
});
