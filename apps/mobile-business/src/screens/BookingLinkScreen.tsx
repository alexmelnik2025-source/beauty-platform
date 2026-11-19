import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { BusinessApi, Location, StaffList } from '../api';
import { WEB_URL } from '../config';
import { errorText } from '../errors';
import { fill, type Dictionary } from '../i18n';
import { encodeQr, qrRuns } from '../qr';
import {
  bookingLink,
  embedCode,
  qrLink,
  shareLink,
  shareText,
  shortLink,
  staffQrLink,
  type ShareTools,
  type TextShareTools,
} from '../share';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import type { SalonChoice } from './SalonsScreen';

/**
 * Task 152: "Link do rezerwacji" — the owner or a manager sees the salon's booking link and
 * sends it on (Instagram bio, WhatsApp…). When online booking is off, a hint says so.
 * Task 354: below it the salon's QR code — shown at the front desk or screenshotted for print.
 * Task 355: the short link (Instagram bio, business card) and the booking button for the salon's
 * own website, as in the cabinet's "Udostępnij".
 * Task Q2: a QR code for each specialist — tap a name, show or screenshot their code, share
 * their link; the booking page opens that specialist's times straight after the service.
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
  const [staff, setStaff] = useState<StaffList>([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [shortInfo, setShortInfo] = useState('');
  const [embedInfo, setEmbedInfo] = useState('');

  const load = useCallback(async () => {
    try {
      setLocation(await api.location(salon.orgId, salon.locationId));
      setError('');
    } catch (e) {
      setError(errorText(e, t));
    }
    // Only an extra: without the list the salon's own code is still there.
    try {
      setStaff((await api.staff(salon.orgId, salon.locationId)).filter((s) => s.active));
    } catch {
      setStaff([]);
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

  const shareShort = async () => {
    if (!location) return;
    const url = shortLink(WEB_URL, location);
    const content = {
      message: fill(b.message, { name: location.name, url }),
      url,
      title: location.name,
    };
    const result = await shareLink(content, shareTools());
    setShortInfo(result === 'copied' ? b.copied : result === 'failed' ? b.failed : '');
  };

  const shareEmbed = async () => {
    if (!location) return;
    const result = await shareText(
      { title: b.embedTitle, message: embedCode(WEB_URL, location) },
      codeShareTools(),
    );
    setEmbedInfo(result === 'copied' ? b.codeCopied : result === 'failed' ? b.failed : '');
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
          <Card>
            <Text role="heading" style={styles.qrTitle}>
              {b.shortTitle}
            </Text>
            <Text selectable style={styles.link}>
              {shortLink(WEB_URL, location)}
            </Text>
            <Text style={styles.muted}>{b.shortHint}</Text>
            <Button kind="secondary" label={b.shortShare} onPress={() => void shareShort()} />
            {shortInfo ? (
              <Text role="status" style={styles.info}>
                {shortInfo}
              </Text>
            ) : null}
          </Card>
          <SalonQr link={qrLink(WEB_URL, location)} name={location.name} t={t} />
          {staff.length > 0 ? <StaffQr location={location} staff={staff} t={t} /> : null}
          <Card>
            <Text role="heading" style={styles.qrTitle}>
              {b.embedTitle}
            </Text>
            <Text selectable style={styles.code} accessibilityLabel={b.embedTitle}>
              {embedCode(WEB_URL, location)}
            </Text>
            <Text style={styles.muted}>{b.embedHint}</Text>
            <Button kind="secondary" label={b.embedCopy} onPress={() => void shareEmbed()} />
            {embedInfo ? (
              <Text role="status" style={styles.info}>
                {embedInfo}
              </Text>
            ) : null}
          </Card>
        </>
      )}
    </ScrollView>
  );
}

/** Pixels per module: a typical salon link (version 3–5, 29–37 modules) is ~240–300 px wide. */
const MODULE = 7;
/** Light border around the code (4 modules, as the standard asks) — scanners need it. */
const QUIET = 4;

/** The salon's code: the short link marked as coming from the QR code (task 354). */
function SalonQr(props: { link: string; name: string; t: Dictionary }) {
  const b = props.t.bookingLink;
  return (
    <Card>
      <Text role="heading" style={styles.qrTitle}>
        {b.qrTitle}
      </Text>
      <QrFigure link={props.link} name={props.name} alt={b.qrAlt} testID="salon-qr" t={props.t} />
      <Text style={styles.muted}>{b.qrHint}</Text>
    </Card>
  );
}

/**
 * Task Q2: a QR code for each specialist. Nothing is drawn until a name is tapped (one code at a
 * time, the screen stays short); "Udostępnij link specjalisty" sends the same link as a message.
 */
function StaffQr(props: { location: Location; staff: StaffList; t: Dictionary }) {
  const { location, staff, t } = props;
  const b = t.bookingLink;
  const [staffId, setStaffId] = useState('');
  const [info, setInfo] = useState('');
  const chosen = staff.find((s) => s.id === staffId);
  const link = chosen ? staffQrLink(WEB_URL, location, chosen.id) : '';

  const share = async () => {
    if (!chosen) return;
    const result = await shareLink(
      {
        message: fill(b.staffQrMessage, {
          name: chosen.displayName,
          salon: location.name,
          url: link,
        }),
        url: link,
        title: chosen.displayName,
      },
      shareTools(),
    );
    setInfo(result === 'copied' ? b.copied : result === 'failed' ? b.failed : '');
  };

  return (
    <Card>
      <Text role="heading" style={styles.qrTitle}>
        {b.staffQrTitle}
      </Text>
      <View style={styles.chips} role="group" aria-label={b.staffQrTitle}>
        {staff.map((s) => {
          const on = s.id === staffId;
          return (
            <Pressable
              key={s.id}
              accessibilityRole="button"
              aria-pressed={on}
              accessibilityState={{ selected: on }}
              onPress={() => {
                setStaffId(on ? '' : s.id);
                setInfo('');
              }}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && { color: '#fff' }]}>{s.displayName}</Text>
            </Pressable>
          );
        })}
      </View>
      {chosen ? (
        <>
          <QrFigure
            link={link}
            name={chosen.displayName}
            sub={location.name}
            alt={fill(b.staffQrAlt, { name: chosen.displayName })}
            testID="staff-qr"
            t={t}
          />
          <Button kind="secondary" label={b.staffQrShare} onPress={() => void share()} />
          {info ? (
            <Text role="status" style={styles.info}>
              {info}
            </Text>
          ) : null}
        </>
      ) : null}
      <Text style={styles.muted}>{b.staffQrHint}</Text>
    </Card>
  );
}

/** The QR code drawn with plain Views — one per horizontal run of dark modules. */
function QrFigure(props: {
  link: string;
  name: string;
  sub?: string;
  alt: string;
  testID: string;
  t: Dictionary;
}) {
  const { link, name, sub, alt, testID, t } = props;
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
    <View style={styles.qrCard}>
      <View
        role="img"
        accessibilityLabel={alt}
        testID={testID}
        style={[styles.qr, { width: side, height: side }]}
      >
        {modules}
      </View>
      <Text style={styles.qrName}>{name}</Text>
      {sub ? <Text style={styles.qrScan}>{sub}</Text> : null}
      <Text style={styles.qrScan}>{b.qrScan}</Text>
      <Text style={styles.muted}>{link.replace(/^https?:\/\//, '').replace(/\?.*$/, '')}</Text>
    </View>
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

/**
 * The website code is pasted into a site, so in the web preview it is copied straight away; on a
 * phone the share sheet opens (it has "Copy", mail and notes).
 */
function codeShareTools(): TextShareTools {
  if (Platform.OS !== 'web') {
    return { native: (c) => Share.share({ message: c.message, title: c.title }) };
  }
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return { copy: nav?.clipboard ? (text) => nav.clipboard.writeText(text) : undefined };
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 15, color: colors.ink },
  qrScan: { fontSize: 15, color: colors.ink },
  code: {
    fontSize: 13,
    color: colors.ink,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
});
