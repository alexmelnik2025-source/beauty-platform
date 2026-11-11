import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { FavoriteSalon, Locale } from '../api';
import type { Dictionary } from '../i18n';
import { OpenNow } from '../OpenNow';
import { addressText } from '../salon';
import { Button, Card, colors } from '../ui';

/**
 * "Favourites": the salons the client saved, newest first — book, open the salon's page or
 * take it off the list. A salon that paused online booking stays, greyed out.
 * Task 367: "Otwarte · do 20:00" on each bookable salon — today's real hours, as in the catalogue.
 */
export function FavoritesView(props: {
  t: Dictionary;
  locale: Locale;
  items: FavoriteSalon[];
  onOpen: (slug: string, name: string) => void;
  onBook: (slug: string, name: string) => void;
  /** Resolves when the server has removed it (the list then reloads). */
  onRemove: (slug: string) => Promise<void>;
}) {
  const { t, items } = props;
  const [removing, setRemoving] = useState<string | null>(null);
  if (items.length === 0) return <Text style={styles.empty}>{t.favorites.empty}</Text>;

  const remove = async (slug: string) => {
    setRemoving(slug);
    try {
      await props.onRemove(slug);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      {items.map((salon) => (
        <Card key={salon.slug}>
          <Text role="heading" aria-level={2} style={styles.name}>
            {salon.name}
          </Text>
          <Text style={styles.muted}>{addressText(salon)}</Text>
          {salon.bookable ? (
            <View style={styles.status}>
              <OpenNow salon={salon} t={t} locale={props.locale} />
            </View>
          ) : null}
          {salon.bookable ? (
            <Button
              label={t.salon.book}
              onPress={() => props.onBook(salon.slug, salon.name)}
              disabled={removing !== null}
            />
          ) : (
            <Text style={styles.paused}>{t.favorites.notBookable}</Text>
          )}
          <View style={styles.row}>
            {salon.bookable ? (
              <Button
                kind="link"
                label={`${t.favorites.open} ›`}
                a11yLabel={`${t.favorites.open}: ${salon.name}`}
                onPress={() => props.onOpen(salon.slug, salon.name)}
              />
            ) : null}
            <Button
              kind="link"
              label={t.favorites.remove}
              a11yLabel={`${t.favorites.remove}: ${salon.name}`}
              busy={removing === salon.slug}
              disabled={removing !== null && removing !== salon.slug}
              onPress={() => void remove(salon.slug)}
            />
          </View>
        </Card>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { color: colors.muted, fontSize: 16, textAlign: 'center', paddingVertical: 32 },
  name: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: 8 },
  status: { marginTop: -4, marginBottom: 8 },
  paused: { color: colors.muted, fontSize: 14, fontStyle: 'italic' },
  row: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', marginTop: 4 },
});
