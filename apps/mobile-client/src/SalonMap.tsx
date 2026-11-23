import { useEffect, useState } from 'react';
import { Image, Linking, StyleSheet, Text, View } from 'react-native';
import type { ClientApi, DirectorySalon, Locale, SpokenLanguage } from './api';
import { API_URL } from './config';
import { formatPrice, ratingText } from './format';
import { fill, type Dictionary } from './i18n';
import { mapLayout, MARKER_SIZE } from './map';
import { OpenNow } from './OpenNow';
import { addressText } from './salon';
import { Button, colors, Pressable } from './ui';

const HEIGHT = 300;

type Located = DirectorySalon & { latitude: number; longitude: number };

const located = (s: DirectorySalon): s is Located => s.latitude !== null && s.longitude !== null;

/**
 * Task 160: the catalogue's map (OpenStreetMap tiles, free). A tap on a marker opens a small
 * card: photo, name, address, how many specialists speak the chosen language, whether there is
 * a free time today, "Umów" → the salon's page.
 */
export function SalonMap(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  salons: DirectorySalon[];
  /** Task 192: the languages chosen in the catalogue (any of them). */
  languages: SpokenLanguage[];
  onOpen: (salon: DirectorySalon) => void;
}) {
  const { t } = props;
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [freeToday, setFreeToday] = useState<boolean | null>(null);
  const [tilesFailed, setTilesFailed] = useState(false);
  const points = props.salons.filter(located);
  const layout = mapLayout(points, width, HEIGHT);
  const salon = points.find((s) => s.slug === selected) ?? null;

  useEffect(() => {
    setFreeToday(null);
    if (!selected) return;
    let live = true;
    props.api
      .freeToday(selected)
      .then((res) => live && setFreeToday(res.staffIds.length > 0))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [props.api, selected]);

  // A salon filtered away closes its card.
  const slugs = points.map((s) => s.slug).join('|');
  useEffect(() => {
    if (selected && !slugs.split('|').includes(selected)) setSelected(null);
  }, [slugs, selected]);

  return (
    <View style={{ gap: 10 }}>
      <View
        role="region"
        aria-label={t.catalog.mapTitle}
        style={styles.map}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        {layout?.tiles.map((tile) => (
          <Image
            key={tile.key}
            source={{ uri: tile.url }}
            style={[styles.tile, { left: tile.x, top: tile.y }]}
            onError={() => setTilesFailed(true)}
          />
        ))}
        {layout?.markers.map(({ item, x, y }) => {
          const on = item.slug === selected;
          const speaking = props.languages.length > 0 ? item.staffSpeaking : null;
          return (
            <Pressable
              key={item.slug}
              accessibilityRole="button"
              accessibilityLabel={fill(t.catalog.marker, { name: item.name })}
              aria-pressed={on}
              onPress={() => setSelected(item.slug)}
              style={[styles.marker, { left: x - MARKER_SIZE / 2, top: y - MARKER_SIZE / 2 }]}
            >
              <View style={[styles.pin, on && styles.pinOn]}>
                {speaking ? <Text style={styles.markerText}>{speaking}</Text> : null}
              </View>
            </Pressable>
          );
        })}
        {width > 0 && (points.length === 0 || tilesFailed) ? (
          <View style={styles.empty} pointerEvents="none">
            <Text role={tilesFailed ? 'alert' : undefined} style={styles.emptyText}>
              {tilesFailed ? t.catalog.mapOffline : t.catalog.mapEmpty}
            </Text>
          </View>
        ) : null}
      </View>
      <Pressable
        accessibilityLabel="OpenStreetMap"
        accessibilityRole="link"
        onPress={() => void Linking.openURL('https://www.openstreetmap.org/copyright')}
        style={styles.credit}
      >
        <Text style={styles.creditText}>© OpenStreetMap</Text>
      </Pressable>
      {salon ? (
        <View role="region" aria-label={salon.name} style={styles.card}>
          {salon.photoUrl ? (
            <Image
              source={{ uri: `${API_URL}${salon.photoUrl}` }}
              accessibilityLabel={salon.name}
              style={styles.photo}
            />
          ) : null}
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.name}>{salon.name}</Text>
            <Text style={styles.small}>{addressText(salon)}</Text>
            <OpenNow salon={salon} t={t} locale={props.locale} />
            {ratingText(salon, t.catalog.rating, props.locale) ? (
              <Text style={styles.small}>{ratingText(salon, t.catalog.rating, props.locale)}</Text>
            ) : null}
            {props.languages.length > 0 && salon.staffSpeaking ? (
              <Text style={styles.small}>
                {fill(t.catalog.speakingStaff, {
                  language: props.languages.map((l) => t.spoken[l]).join(', '),
                  n: String(salon.staffSpeaking),
                })}
              </Text>
            ) : null}
            {salon.priceFromGrosze !== null ? (
              <Text style={styles.small}>
                {fill(t.catalog.priceFrom, {
                  price: formatPrice(salon.priceFromGrosze, salon.currency, props.locale),
                })}
              </Text>
            ) : null}
            {freeToday !== null ? (
              <Text style={[styles.small, freeToday && styles.free]}>
                {freeToday ? `● ${t.catalog.freeToday}` : t.catalog.notFreeToday}
              </Text>
            ) : null}
            <View style={{ marginTop: 6 }}>
              <Button label={t.salon.book} onPress={() => props.onOpen(salon)} />
            </View>
          </View>
        </View>
      ) : points.length > 0 ? (
        <Text style={styles.small}>{t.catalog.mapHint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    height: HEIGHT,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: colors.soft,
    position: 'relative',
  },
  tile: { position: 'absolute', width: 256, height: 256 },
  marker: {
    position: 'absolute',
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pin: {
    minWidth: 24,
    minHeight: 24,
    borderRadius: 12,
    backgroundColor: '#c72d43',
    borderWidth: 3,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinOn: { minWidth: 30, minHeight: 30, borderRadius: 15, backgroundColor: colors.ink },
  markerText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  empty: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: colors.ink,
    fontSize: 14,
    backgroundColor: 'rgba(255,255,255,0.9)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    textAlign: 'center',
    maxWidth: '85%',
  },
  credit: {
    alignSelf: 'flex-end',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.8)',
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  creditText: { fontSize: 10, color: colors.muted },
  card: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 12,
  },
  photo: { width: 72, height: 72, borderRadius: 10 },
  name: { fontSize: 17, fontWeight: '700', color: colors.ink },
  small: { color: colors.muted, fontSize: 14 },
  free: { color: '#1f7a45', fontWeight: '600' },
});
