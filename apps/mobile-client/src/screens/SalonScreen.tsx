import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ClientApi, Locale, PublicLocation } from '../api';
import { API_URL } from '../config';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { formatPrice } from '../format';
import { addressText, durationText, openingRows, serviceGroups, specialtyText } from '../salon';
import { Button, Card, colors, ErrorText, Heading } from '../ui';

/**
 * A salon's page: photos, address, languages, description, opening hours, price list and
 * specialists. "Book" starts the booking in the app.
 */
export function SalonScreen(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  slug: string;
  name: string;
  onBack: () => void;
  onBook: (salon: PublicLocation) => void;
}) {
  const { api, t, locale } = props;
  const [salon, setSalon] = useState<PublicLocation | null>(null);
  const [error, setError] = useState('');
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(async () => {
    setError('');
    try {
      setSalon(await api.salon(props.slug));
    } catch (e) {
      setError(errorText(e, tRef.current));
    }
  }, [api, props.slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = <Button kind="link" label={t.salon.back} onPress={props.onBack} />;
  if (!salon) {
    return (
      <View style={styles.screen}>
        <View style={styles.top}>{back}</View>
        <Heading>{props.name}</Heading>
        {error ? (
          <>
            <ErrorText>{error}</ErrorText>
            <Button kind="secondary" label={t.retry} onPress={load} />
          </>
        ) : (
          <ActivityIndicator style={{ marginTop: 24 }} color={colors.ink} />
        )}
      </View>
    );
  }

  const groups = serviceGroups(salon);
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.top}>{back}</View>
      <Heading>{salon.name}</Heading>
      <Text style={styles.text}>{addressText(salon)}</Text>
      {salon.languages.length > 0 ? (
        <Text style={styles.small}>
          {t.salon.speaks}: {salon.languages.map((l) => t.spoken[l]).join(', ')}
        </Text>
      ) : null}
      {salon.photos.length > 0 ? (
        <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
          {salon.photos.map((p) => (
            <Image
              key={p.id}
              source={{ uri: `${API_URL}${p.url}` }}
              accessibilityLabel={salon.name}
              style={styles.photo}
            />
          ))}
        </ScrollView>
      ) : null}
      <Button label={t.salon.book} onPress={() => props.onBook(salon)} />
      <Text style={styles.small}>{t.salon.bookHint}</Text>
      {salon.phone ? (
        <Button
          kind="secondary"
          label={`${t.salon.call} ${salon.phone}`}
          onPress={() => void Linking.openURL(`tel:${salon.phone}`)}
        />
      ) : null}

      {salon.description ? (
        <Section title={t.salon.about}>
          <Text style={styles.body}>{salon.description}</Text>
        </Section>
      ) : null}

      <Section title={t.salon.hours}>
        {openingRows(salon, locale).map((row) => (
          <View key={row.weekday} style={styles.row}>
            <Text style={styles.body}>{row.name}</Text>
            <Text style={[styles.body, !row.hours && { color: colors.muted }]}>
              {row.hours ?? t.salon.closed}
            </Text>
          </View>
        ))}
      </Section>

      <Section title={t.salon.services}>
        {groups.length === 0 ? <Text style={styles.text}>{t.salon.noServices}</Text> : null}
        {groups.map((g) => (
          <View key={g.id ?? 'other'} style={{ gap: 6 }}>
            {groups.length > 1 || g.name ? (
              <Text style={styles.group}>{g.name ?? t.salon.otherServices}</Text>
            ) : null}
            {g.services.map((s) => (
              <View key={s.id} style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.body}>{s.name}</Text>
                  <Text style={styles.small}>{durationText(s.durationMinutes, t.units)}</Text>
                </View>
                <Text style={styles.price}>{formatPrice(s.priceGrosze, locale)}</Text>
              </View>
            ))}
          </View>
        ))}
      </Section>

      {salon.staff.length > 0 ? (
        <Section title={t.salon.team}>
          {salon.staff.map((m) => (
            <View key={m.id} style={styles.person}>
              {m.photoUrl ? (
                <Image
                  source={{ uri: `${API_URL}${m.photoUrl}` }}
                  accessibilityLabel={m.displayName}
                  style={styles.avatar}
                />
              ) : (
                <View style={[styles.avatar, styles.initial]}>
                  <Text style={styles.initialText}>{m.displayName.slice(0, 1).toUpperCase()}</Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.body}>{m.displayName}</Text>
                {specialtyText(m, t.specialty) ? (
                  <Text style={styles.small}>{specialtyText(m, t.specialty)}</Text>
                ) : null}
                {m.languages.length > 0 ? (
                  <Text style={styles.small}>
                    {t.salon.speaks}: {m.languages.map((l) => t.spoken[l]).join(', ')}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </Section>
      ) : null}
    </ScrollView>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <Card>
      <Text role="heading" aria-level={2} style={styles.section}>
        {props.title}
      </Text>
      <View style={{ gap: 8, marginTop: 6 }}>{props.children}</View>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  top: { flexDirection: 'row', marginLeft: -8 },
  text: { color: colors.muted, fontSize: 15, lineHeight: 21 },
  small: { color: colors.muted, fontSize: 14 },
  body: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  section: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  group: { color: colors.gold, fontSize: 13, fontWeight: '700', letterSpacing: 1, marginTop: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  price: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  photo: { width: 220, height: 150, borderRadius: 12, backgroundColor: colors.line },
  person: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.line },
  initial: { alignItems: 'center', justifyContent: 'center' },
  initialText: { color: colors.ink, fontSize: 18, fontWeight: '700' },
});
