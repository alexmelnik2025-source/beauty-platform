import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ClientApi, DirectorySalon, Locale } from '../api';
import { formatKm, formatPrice, ratingText } from '../format';
import { fill, type Dictionary } from '../i18n';
import { OpenNow } from '../OpenNow';
import { addressText, nearbyOnly } from '../salon';
import { Card, colors } from '../ui';

const NEARBY_COUNT = 3;

/**
 * Task 401: "Inne salony w pobliżu" at the end of a salon page in the client app — up to three
 * salons of the catalogue nearest to this one (within 30 km), with the distance, "Otwarte teraz",
 * the stars and the lowest price; a tap opens that salon. Nothing without neighbours.
 */
export function NearbySalons(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  slug: string;
  onOpen: (salon: DirectorySalon) => void;
}) {
  const { api, t, locale, slug } = props;
  const [salons, setSalons] = useState<DirectorySalon[]>([]);

  useEffect(() => {
    let live = true;
    api
      .directory({ nearSalon: slug, pageSize: NEARBY_COUNT })
      .then((res) => live && setSalons(nearbyOnly(res.items)))
      .catch(() => live && setSalons([]));
    return () => {
      live = false;
    };
  }, [api, slug]);

  if (salons.length === 0) return null;
  return (
    <Card>
      <Text role="heading" aria-level={2} style={styles.section}>
        {t.salon.nearbyTitle}
      </Text>
      <View style={{ gap: 4, marginTop: 6 }}>
        {salons.map((s) => (
          <Pressable
            key={s.slug}
            role="link"
            aria-label={s.name}
            onPress={() => props.onOpen(s)}
            style={({ pressed }) => [styles.item, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.name}>{s.name}</Text>
            <Text style={styles.small}>{addressText(s)}</Text>
            <Text style={styles.small}>
              {fill(t.salon.nearbyDistance, { km: formatKm(s.distanceKm ?? 0, locale) })}
            </Text>
            <OpenNow salon={s} t={t} locale={locale} />
            {ratingText(s, t.catalog.rating, locale) ? (
              <Text style={styles.strong}>{ratingText(s, t.catalog.rating, locale)}</Text>
            ) : null}
            {s.priceFromGrosze !== null ? (
              <Text style={styles.strong}>
                {fill(t.catalog.priceFrom, {
                  price: formatPrice(s.priceFromGrosze, s.currency, locale),
                })}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  section: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  item: { gap: 2, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line },
  name: { color: colors.accent, fontSize: 16, fontWeight: '700' },
  small: { color: colors.muted, fontSize: 14 },
  strong: { color: colors.ink, fontSize: 14, fontWeight: '600' },
});
