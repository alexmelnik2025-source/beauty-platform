import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { bookingUrl, type ClientApi, type Locale, type PublicLocation } from '../api';
import { catalogLanguagesStore } from '../storage';
import { API_URL, WEB_URL } from '../config';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { priceRows, speakersFirst } from '../booking';
import { formatPrice, servicePriceText } from '../format';
import { addressText, durationText, openingRows, serviceGroups, specialtyText } from '../salon';
import { QrView } from '../QrView';
import { shareMessage, shareSalon, type ShareTools } from '../share';
import { SalonReviews } from './SalonReviews';
import { Button, Card, colors, ErrorText, Heading } from '../ui';

/**
 * A salon's page: photos, address, languages, description, opening hours, price list and
 * specialists. "Book" starts the booking in the app. A signed-in client can save the salon to
 * "Favourites" (and take it off). Task 212: the salon's reviews at the bottom.
 */
export function SalonScreen(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  slug: string;
  name: string;
  onBack: () => void;
  onBook: (salon: PublicLocation) => void;
  /** Signed in: the "Add to favourites" button is shown. */
  signedIn: boolean;
  /** The salon was saved or removed: "Favourites" in "My visits" reloads. */
  onFavoriteChanged: () => void;
}) {
  const { api, t, locale, signedIn, onFavoriteChanged } = props;
  const [salon, setSalon] = useState<PublicLocation | null>(null);
  // Task 120: "Wolne dziś" — who can still be booked today.
  const [freeToday, setFreeToday] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  // null = not known yet (or not signed in): no button.
  const [saved, setSaved] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [favoriteError, setFavoriteError] = useState('');
  const [shareInfo, setShareInfo] = useState('');
  // Task 357: the salon's QR code for a friend standing next to you.
  const [qrOpen, setQrOpen] = useState(false);
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(async () => {
    setError('');
    try {
      const [loaded, chosen] = await Promise.all([
        api.salon(props.slug),
        catalogLanguagesStore.get(),
      ]);
      // Task 160c: specialists speaking a language chosen in the catalogue come first.
      setSalon({ ...loaded, staff: speakersFirst(loaded.staff, chosen) });
      api
        .freeToday(props.slug)
        .then((res) => setFreeToday(new Set(res.staffIds)))
        .catch(() => undefined);
    } catch (e) {
      setError(errorText(e, tRef.current));
    }
  }, [api, props.slug]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!signedIn) {
      setSaved(null);
      return;
    }
    let live = true;
    api
      .favorites()
      .then((list) => live && setSaved(list.items.some((s) => s.slug === props.slug)))
      .catch(() => live && setSaved(null));
    return () => {
      live = false;
    };
  }, [api, signedIn, props.slug]);

  const toggleFavorite = useCallback(async () => {
    if (saved === null) return;
    setSaving(true);
    setFavoriteError('');
    try {
      if (saved) await api.removeFavorite(props.slug);
      else await api.addFavorite(props.slug);
      setSaved(!saved);
      onFavoriteChanged();
    } catch (e) {
      setFavoriteError(errorText(e, tRef.current));
    } finally {
      setSaving(false);
    }
  }, [api, saved, props.slug, onFavoriteChanged]);

  // Task 151: "Poleć salon" — the booking link in the phone's share sheet (or copied on the web).
  const share = useCallback(async () => {
    if (!salon) return;
    const url = bookingUrl(WEB_URL, locale, salon.slug);
    const content = shareMessage(t.salon.shareText, salon.name, url);
    const result = await shareSalon(content, shareTools());
    if (result === 'copied') setShareInfo(t.salon.copied);
    else if (result === 'failed') setShareInfo(t.salon.shareFailed.replace('{url}', url));
    else setShareInfo('');
  }, [salon, locale, t]);

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
      {saved !== null ? (
        <Button
          kind="secondary"
          label={saved ? t.favorites.saved : t.favorites.add}
          a11yLabel={saved ? t.favorites.remove : t.favorites.add}
          busy={saving}
          onPress={() => void toggleFavorite()}
        />
      ) : null}
      {favoriteError ? <ErrorText>{favoriteError}</ErrorText> : null}
      <Button kind="secondary" label={t.salon.share} onPress={() => void share()} />
      {shareInfo ? (
        <Text role="status" style={styles.small}>
          {shareInfo}
        </Text>
      ) : null}
      <Button
        kind="secondary"
        label={qrOpen ? t.salon.qrHide : t.salon.qrShow}
        onPress={() => setQrOpen(!qrOpen)}
      />
      {qrOpen ? (
        <View style={styles.qrCard}>
          <QrView text={bookingUrl(WEB_URL, locale, salon.slug)} label={t.salon.qrAlt} />
          <Text style={styles.qrName}>{salon.name}</Text>
          <Text style={styles.small}>{t.salon.qrHint}</Text>
        </View>
      ) : null}
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
            {g.services.map((s) => {
              // Task 70c: who does it for how much, when the specialists' prices or lengths differ.
              const rows = priceRows(salon, s.id);
              return (
                <View key={s.id} style={{ gap: 2 }}>
                  <View style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.body}>{s.name}</Text>
                      <Text style={styles.small}>{durationText(s.durationMinutes, t.units)}</Text>
                    </View>
                    <Text style={styles.price}>
                      {servicePriceText(s, salon.currency, locale, t.book.priceFrom)}
                    </Text>
                  </View>
                  {rows.length > 1
                    ? rows.map((r) => (
                        <View key={`${r.priceGrosze}|${r.durationMinutes}`} style={styles.row}>
                          <Text style={[styles.small, { flex: 1 }]}>
                            {r.staff.map((x) => x.displayName).join(', ')}
                          </Text>
                          <Text style={styles.small}>
                            {formatPrice(r.priceGrosze, salon.currency, locale)} ·{' '}
                            {durationText(r.durationMinutes, t.units)}
                          </Text>
                        </View>
                      ))
                    : null}
                </View>
              );
            })}
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
                {freeToday.has(m.id) ? (
                  <Text role="note" style={styles.freeToday}>
                    ● {t.salon.freeToday}
                  </Text>
                ) : null}
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

      <SalonReviews api={api} t={t} locale={locale} slug={salon.slug} />
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
  qrCard: { alignItems: 'center', gap: 6, paddingVertical: 8 },
  qrName: { fontSize: 17, fontWeight: '700', color: colors.ink },
  screen: { padding: 20, gap: 12 },
  top: { flexDirection: 'row', marginLeft: -8 },
  text: { color: colors.muted, fontSize: 15, lineHeight: 21 },
  small: { color: colors.muted, fontSize: 14 },
  freeToday: { color: '#1f7a45', fontSize: 14, fontWeight: '600' },
  body: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  section: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  group: { color: colors.accent, fontSize: 13, fontWeight: '700', letterSpacing: 1, marginTop: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  price: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  photo: { width: 220, height: 150, borderRadius: 12, backgroundColor: colors.line },
  person: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.line },
  initial: { alignItems: 'center', justifyContent: 'center' },
  initialText: { color: colors.ink, fontSize: 18, fontWeight: '700' },
});

/** What this platform can share with: the share sheet on phones, the browser's tools on the web. */
function shareTools(): ShareTools {
  if (Platform.OS !== 'web') {
    // The link is in the message already (iOS would add `url` a second time).
    return { native: (c) => Share.share({ message: c.message, title: c.title }) };
  }
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    webShare: nav?.share ? (data) => nav.share(data) : undefined,
    copy: nav?.clipboard ? (text) => nav.clipboard.writeText(text) : undefined,
  };
}
