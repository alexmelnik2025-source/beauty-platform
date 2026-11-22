import { Pressable, StyleSheet, Text } from 'react-native';
import { colors } from '../ui';

export function DiscountedTime({
  time,
  percent,
  listPrice,
  onPress,
}: {
  time: string;
  percent: number;
  listPrice?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[time, listPrice, `−${percent}%`].filter(Boolean).join(' · ')}
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
    minHeight: 44,
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { color: colors.ink, fontWeight: '600', fontSize: 14 },
  listPrice: { color: colors.muted, fontSize: 12, textDecorationLine: 'line-through' },
});
