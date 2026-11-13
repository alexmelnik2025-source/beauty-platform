import { StyleSheet, Text, View } from 'react-native';
import type { Dictionary } from '../i18n';
import type { RecentSalon } from '../recent';
import { Button, colors } from '../ui';

/**
 * Tasks 402, 414, 415: "Ostatnio oglądane" — the salons opened last on this device, a tap opens
 * one; "Wyczyść listę" forgets them. On the start screen and in "Moje wizyty". Nothing when empty.
 */
export function RecentSalons(props: {
  t: Dictionary;
  recent: RecentSalon[];
  onOpen: (salon: RecentSalon) => void;
  onClear: () => void;
}) {
  const { t } = props;
  if (props.recent.length === 0) return null;
  return (
    <View role="group" aria-label={t.catalog.recent} style={styles.recent}>
      <Text role="heading" aria-level={2} style={styles.recentTitle}>
        {t.catalog.recent}
      </Text>
      <View style={styles.recentRow}>
        {props.recent.map((salon) => (
          <Button
            key={salon.slug}
            kind="link"
            label={salon.name}
            onPress={() => props.onOpen(salon)}
          />
        ))}
      </View>
      <Button kind="link" label={t.catalog.recentClear} onPress={props.onClear} />
    </View>
  );
}

const styles = StyleSheet.create({
  recent: { gap: 2 },
  recentTitle: { color: colors.muted, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  recentRow: { flexDirection: 'row', flexWrap: 'wrap', marginLeft: -8 },
});
