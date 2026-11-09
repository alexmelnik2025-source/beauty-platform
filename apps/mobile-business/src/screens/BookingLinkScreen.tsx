import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { BackHandler, Platform, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import type { BusinessApi, Location } from '../api';
import { WEB_URL } from '../config';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { encodeQr, qrRuns } from '../qr';
import { bookingLink, qrLink, shareLink, type ShareTools } from '../share';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 152: "Link do rezerwacji" — the owner or a manager sees the salon's booking link and
 * sends it on (Instagram bio, WhatsApp…). When online booking is off, a hint says so.
 * Task 354: below it the salon's QR code — shown at the front desk or screenshotted for print.
 */
export function BookingLinkScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  onBack: () => void;
}) {
  const { api, t, salon, onBack } = props;
  const b = t.bookingLink;
  const [location, setLocation] = useState<Location | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const load = useCallback(async () => {
    try {
      setLocation(await api.location(salon.orgId, salon.locationId));
      setError('');
    } catch (e) {
      setError(errorText(e, t));
    }
  }, [api, salon, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Android's back button closes the screen instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const link = location ? bookingLink(WEB_URL, location) : null;

  const share = async () => {
    if (!location || !link) return;
    const content = {
      message: fill(b.message, { name: location.name, url: link }),
      url: link,
      title: location.name,
    };
    const result = await shareLink(content, shareTools());
    setInfo(result === 'copied' ? b.copied : result === 'failed' ? b.failed : '');
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Button kind="link" label={b.back} onPress={onBack} />
      <Heading>{b.title}</Heading>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {!location || !link ? (
        error ? null : (
          <Text style={styles.muted}>{t.loading}</Text>
        )
      ) : (
        <>
          <Card>
            <Text selectable style={styles.link} accessibilityLabel={b.title}>
              {link}
            </Text>
          </Card>
          {!location.onlineBookingEnabled ? <Text style={styles.warn}>{b.offline}</Text> : null}
          <Text style={styles.muted}>{b.hint}</Text>
          <Button label={b.share} onPress={() => void share()} />
          {info ? (
            <Text role="status" style={styles.info}>
              {info}
            </Text>
          ) : null}
          <SalonQr link={qrLink(WEB_URL, location)} name={location.name} t={t} />
        </>
      )}
    </ScrollView>
  );
}

/** Pixels per module: a typical salon link (version 3–5, 29–37 modules) is ~240–300 px wide. */
const MODULE = 7;
/** Light border around the code (4 modules, as the standard asks) — scanners need it. */
const QUIET = 4;

/** The QR code drawn with plain Views — one per horizontal run of dark modules. */
function SalonQr(props: { link: string; name: string; t: Dictionary }) {
  const { link, name, t } = props;
  const b = t.bookingLink;
  const qr = useMemo(() => encodeQr(link), [link]);
  const runs = useMemo(() => qrRuns(qr), [qr]);
  const side = (qr.size + QUIET * 2) * MODULE;
  const modules: ReactElement[] = runs.map((r) => (
    <View
      key={`${r.x}-${r.y}`}
      style={[
        styles.module,
        {
          left: (r.x + QUIET) * MODULE,
          top: (r.y + QUIET) * MODULE,
          width: r.length * MODULE,
        },
      ]}
    />
  ));
  return (
    <Card>
      <Text role="heading" style={styles.qrTitle}>
        {b.qrTitle}
      </Text>
      <View style={styles.qrCard}>
        <View
          role="img"
          accessibilityLabel={b.qrAlt}
          testID="salon-qr"
          style={[styles.qr, { width: side, height: side }]}
        >
          {modules}
        </View>
        <Text style={styles.qrName}>{name}</Text>
        <Text style={styles.qrScan}>{b.qrScan}</Text>
        <Text style={styles.muted}>{link.replace(/^https?:\/\//, '').replace(/\?.*$/, '')}</Text>
      </View>
      <Text style={styles.muted}>{b.qrHint}</Text>
    </Card>
  );
}

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

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  link: { fontSize: 16, fontWeight: '600', color: colors.ink },
  muted: { color: colors.muted, fontSize: 15 },
  warn: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  info: { color: '#2e7d32', fontSize: 15 },
  qrTitle: { fontSize: 17, fontWeight: '700', color: colors.ink },
  qrCard: { alignItems: 'center', gap: 4, paddingVertical: 8 },
  qr: { backgroundColor: '#fff', position: 'relative' },
  module: { position: 'absolute', height: MODULE, backgroundColor: '#000' },
  qrName: { fontSize: 18, fontWeight: '700', color: colors.ink },
  qrScan: { fontSize: 15, color: colors.ink },
});
