import { memo, useEffect, useMemo, useState, type ReactElement } from 'react';
import { BackHandler, Platform, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
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
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
import type { SalonChoice } from './SalonsScreen';

interface Props {
  api: BusinessApi;
  t: Dictionary;
  salon: SalonChoice;
  onBack: () => void;
}

/**
 * Task 152: "Link do rezerwacji" — the owner or a manager sees the salon's booking link and
 * sends it on (Instagram bio, WhatsApp…). When online booking is off, a hint says so.
 * Task 354: below it the salon's QR code — shown at the front desk or screenshotted for print.
 * Task 355: the short link (Instagram bio, business card) and the booking button for the salon's
 * own website, as in the cabinet's "Udostępnij".
 * Task Q2: the QR code of each specialist (their mirror, their business card) — the client books
 * with that person, and "Skąd przyszli" in the reports counts the visits from each code.
 */
export function BookingLinkScreen(props: Props) {
  const key = JSON.stringify([props.salon.orgId, props.salon.locationId]);
  return <BookingLinks key={key} {...props} />;
}

function BookingLinks(props: Props) {
  const { api, t, salon, onBack } = props;
  const b = t.bookingLink;
  const [location, setLocation] = useState<Location | null>(null);
  const [staff, setStaff] = useState<StaffList>([]);
  const [qrStaff, setQrStaff] = useState('');
  const [staffInfo, setStaffInfo] = useState('');
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const [staffFailure, setStaffFailure] = useState<{ cause: unknown } | null>(null);
  const [locationAttempt, retryLocation] = useState(0);
  const [staffAttempt, retryStaff] = useState(0);
  const [info, setInfo] = useState('');
  const [shortInfo, setShortInfo] = useState('');
  const [embedInfo, setEmbedInfo] = useState('');

  const { orgId, locationId } = salon;
  useEffect(() => {
    let active = true;
    setFailure(null);
    api.location(orgId, locationId).then(
      (loc) => {
        if (active) setLocation(loc);
      },
      (cause: unknown) => {
        if (active) setFailure({ cause });
      },
    );
    return () => {
      active = false;
    };
  }, [api, orgId, locationId, locationAttempt]);

  useEffect(() => {
    let active = true;
    setStaffFailure(null);
    api.staff(orgId, locationId).then(
      (team) => {
        if (active) setStaff(team.filter((s) => s.active));
      },
      (cause: unknown) => {
        if (active) setStaffFailure({ cause });
      },
    );
    return () => {
      active = false;
    };
  }, [api, orgId, locationId, staffAttempt]);

  // Android's back button closes the screen instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  function readError(failed: { cause: unknown }, retry: () => void) {
    return (
      <View style={{ gap: 8 }}>
        <ErrorText>{errorText(failed.cause, t)}</ErrorText>
        <Button kind="secondary" label={t.day.refresh} onPress={retry} />
      </View>
    );
  }

  const link = location ? bookingLink(WEB_URL, location) : null;
  const shortUrl = location ? shortLink(WEB_URL, location) : null;

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
    if (!location || !shortUrl) return;
    const content = {
      message: fill(b.message, { name: location.name, url: shortUrl }),
      url: shortUrl,
      title: location.name,
    };
    const result = await shareLink(content, shareTools());
    setShortInfo(result === 'copied' ? b.copied : result === 'failed' ? b.failed : '');
  };

  /**
   * Task Q2: "Udostępnij link specjalisty" — the chosen specialist's link (the same one their QR
   * code opens) goes to a message, the Instagram bio or the clipboard.
   */
  const shareStaff = async (s: StaffList[number]) => {
    if (!location) return;
    const url = staffQrLink(WEB_URL, location, s.id);
    const content = {
      message: fill(b.staffQrMessage, { name: s.displayName, salon: location.name, url }),
      url,
      title: s.displayName,
    };
    const result = await shareLink(content, shareTools());
    setStaffInfo(result === 'copied' ? b.copied : result === 'failed' ? b.failed : '');
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
      {failure ? readError(failure, () => retryLocation((n) => n + 1)) : null}
      {!location || !link ? (
        failure ? null : (
          <Text style={styles.muted}>{t.loading}</Text>
        )
      ) : (
        <>
          <Card>
            <Text selectable style={styles.link} accessibilityLabel={`${b.title}: ${link}`}>
              {link}
            </Text>
          </Card>
          {!location.onlineBookingEnabled ? <Text style={styles.warn}>{b.offline}</Text> : null}
          <Text style={styles.muted}>{b.hint}</Text>
          <Button
            label={b.share}
            a11yLabel={`${b.share}: ${location.name}`}
            onPress={() => void share()}
          />
          {info ? (
            <Text role="status" accessibilityLiveRegion="polite" style={styles.info}>
              {info}
            </Text>
          ) : null}
          <Card>
            <Text role="heading" style={styles.qrTitle}>
              {b.shortTitle}
            </Text>
            <Text
              selectable
              style={styles.link}
              accessibilityLabel={`${b.shortTitle}: ${shortUrl}`}
            >
              {shortUrl}
            </Text>
            <Text style={styles.muted}>{b.shortHint}</Text>
            <Button
              kind="secondary"
              label={b.shortShare}
              a11yLabel={`${b.shortShare}: ${location.name}`}
              onPress={() => void shareShort()}
            />
            {shortInfo ? (
              <Text role="status" accessibilityLiveRegion="polite" style={styles.info}>
                {shortInfo}
              </Text>
            ) : null}
          </Card>
          <SalonQr link={qrLink(WEB_URL, location)} name={location.name} t={t} />
          {staffFailure ? readError(staffFailure, () => retryStaff((n) => n + 1)) : null}
          {staff.length > 0 ? (
            <Card>
              <Text role="heading" style={styles.qrTitle}>
                {b.staffQrTitle}
              </Text>
              <View style={styles.chips} role="group" accessibilityLabel={b.staffQrTitle}>
                {staff.map((s) => {
                  const on = s.id === qrStaff;
                  return (
                    <Pressable
                      accessibilityLabel={s.displayName}
                      key={s.id}
                      accessibilityRole="button"
                      aria-pressed={on}
                      accessibilityState={{ selected: on }}
                      onPress={() => {
                        setQrStaff(on ? '' : s.id);
                        setStaffInfo('');
                      }}
                      style={[styles.chip, on && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, on && { color: '#fff' }]}>
                        {s.displayName}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {staff
                .filter((s) => s.id === qrStaff)
                .map((s) => (
                  <View
                    key={s.id}
                    style={styles.staffBlock}
                    role="group"
                    accessibilityLabel={s.displayName}
                  >
                    <SalonQr
                      link={staffQrLink(WEB_URL, location, s.id)}
                      name={location.name}
                      staffName={s.displayName}
                      t={t}
                    />
                    <Button
                      kind="secondary"
                      label={b.staffQrShare}
                      onPress={() => void shareStaff(s)}
                    />
                    {staffInfo ? (
                      <Text role="status" accessibilityLiveRegion="polite" style={styles.info}>
                        {staffInfo}
                      </Text>
                    ) : null}
                  </View>
                ))}
              <Text style={styles.muted}>{b.staffQrHint}</Text>
            </Card>
          ) : null}
          <Card>
            <Text role="heading" style={styles.qrTitle}>
              {b.embedTitle}
            </Text>
            <Text selectable style={styles.code} accessibilityLabel={b.embedTitle}>
              {embedCode(WEB_URL, location)}
            </Text>
            <Text style={styles.muted}>{b.embedHint}</Text>
            <Button
              kind="secondary"
              label={b.embedCopy}
              a11yLabel={`${b.embedCopy}: ${b.embedTitle}`}
              onPress={() => void shareEmbed()}
            />
            {embedInfo ? (
              <Text role="status" accessibilityLiveRegion="polite" style={styles.info}>
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

/** The QR code drawn with plain Views — one per horizontal run of dark modules. */
const SalonQr = memo(function SalonQr(props: {
  link: string;
  name: string;
  staffName?: string;
  t: Dictionary;
}) {
  const { link, name, staffName, t } = props;
  const b = t.bookingLink;
  const qr = useMemo(() => encodeQr(link), [link]);
  const runs = useMemo(() => qrRuns(qr), [qr]);
  const [availableWidth, setAvailableWidth] = useState(0);
  const modulesPerSide = qr.size + QUIET * 2;
  const moduleSize = Math.min(MODULE, Math.floor(availableWidth / modulesPerSide));
  const side = modulesPerSide * moduleSize;
  const modules: ReactElement[] = runs.map((r) => (
    <View
      key={`${r.x}-${r.y}`}
      style={[
        styles.module,
        {
          left: (r.x + QUIET) * moduleSize,
          top: (r.y + QUIET) * moduleSize,
          width: r.length * moduleSize,
          height: moduleSize,
        },
      ]}
    />
  ));
  const code = (
    <View
      style={styles.qrCard}
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
    >
      <View
        role="img"
        accessibilityLabel={staffName ? fill(b.staffQrAlt, { name: staffName }) : b.qrAlt}
        testID={staffName ? 'staff-qr' : 'salon-qr'}
        style={[styles.qr, { width: side, height: side }]}
      >
        {modules}
      </View>
      <Text style={styles.qrName}>{name}</Text>
      {staffName ? <Text style={styles.qrName}>{staffName}</Text> : null}
      <Text style={styles.qrScan}>{b.qrScan}</Text>
      <Text style={[styles.muted, styles.qrCaption]}>
        {link.replace(/^https?:\/\//, '').replace(/\?.*$/, '')}
      </Text>
    </View>
  );
  // A specialist's code sits inside the "Kod QR specjalisty" card.
  if (staffName) return code;
  return (
    <Card>
      <Text role="heading" style={styles.qrTitle}>
        {b.qrTitle}
      </Text>
      {code}
      <Text style={styles.muted}>{b.qrHint}</Text>
    </Card>
  );
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
  module: { position: 'absolute', backgroundColor: '#000' },
  qrName: {
    maxWidth: '100%',
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '700',
    color: colors.ink,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  staffBlock: { gap: 8 },
  chip: {
    maxWidth: '100%',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 15, color: colors.ink },
  qrCaption: { maxWidth: '100%', textAlign: 'center' },
  qrScan: { maxWidth: '100%', textAlign: 'center', fontSize: 15, color: colors.ink },
  code: {
    fontSize: 13,
    color: colors.ink,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
});
