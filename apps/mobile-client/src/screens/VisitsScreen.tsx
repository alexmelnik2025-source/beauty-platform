import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type {
  ClientApi,
  ClientAppointment,
  ClientLoyaltyCard,
  ClientPerson,
  FavoriteSalon,
  WaitlistEntry,
  Locale,
  Scope,
} from '../api';
import type { BookingPreset } from '../booking';
import { errorText } from '../errors';
import { formatDay, formatPrice, groupByDay, salonAddress } from '../format';
import { fill, type Dictionary } from '../i18n';
import { LanguageRow } from '../LanguageRow';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import { BonusesView } from './BonusesView';
import { FavoritesView } from './FavoritesView';
import { VisitScreen } from './VisitScreen';

/** The tabs of the screen: upcoming visits, history, bonuses, favourite salons. */
type Tab = Scope | 'bonuses' | 'favorites';

/**
 * "My visits": upcoming and past visits in every salon, found by the client's email, and
 * "My bonuses" — the loyalty cards of those salons — and the client's favourite salons.
 */
export function VisitsScreen(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  person: ClientPerson;
  onLocale: (locale: Locale) => void;
  /** Opens the catalogue of salons (no sign-in needed). */
  onFindSalon: () => void;
  /** The booking in the app: "Book again" on a visit, "Book" on a loyalty card. */
  onBook: (slug: string, name: string, preset?: BookingPreset) => void;
  /** A salon's page (from "Favourites"). */
  onOpenSalon: (slug: string, name: string) => void;
  /** Grows when a salon is saved or removed elsewhere (its page): "Favourites" reloads. */
  favoritesVersion: number;
  onSignOut: () => void;
  /** The server no longer accepts the session (signed out elsewhere, or it ended). */
  onSessionEnded: () => void;
}) {
  const { api, t, locale, onSessionEnded } = props;
  const [tab, setTab] = useState<Tab>('upcoming');
  const [items, setItems] = useState<ClientAppointment[] | null>(null);
  const [bonuses, setBonuses] = useState<ClientLoyaltyCard[] | null>(null);
  const [favorites, setFavorites] = useState<FavoriteSalon[] | null>(null);
  // Waiting lists (task 51) are shown above the upcoming visits.
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<ClientAppointment | null>(null);
  const changed = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'bonuses') setBonuses((await api.loyalty()).items);
      else if (tab === 'favorites') setFavorites((await api.favorites()).items);
      else if (tab === 'upcoming') {
        const [visits, waiting] = await Promise.all([api.appointments(tab), api.waitlist()]);
        setItems(visits.items);
        setWaitlist(waiting.items);
      } else setItems((await api.appointments(tab)).items);
      setError('');
    } catch (e) {
      if (!api.signedIn) return onSessionEnded();
      setError(errorText(e, t));
    } finally {
      setLoading(false);
    }
  }, [api, tab, t, onSessionEnded]);

  useEffect(() => {
    setItems(null);
    setBonuses(null);
    setFavorites(null);
    void load();
  }, [load]);

  // A salon saved or removed on its page: the list is fresh when the client comes back.
  const { favoritesVersion } = props;
  const seenVersion = useRef(favoritesVersion);
  useEffect(() => {
    if (seenVersion.current === favoritesVersion) return;
    seenVersion.current = favoritesVersion;
    if (tab === 'favorites') void load();
  }, [favoritesVersion, tab, load]);

  const leaveWaitlist = useCallback(
    async (id: string) => {
      try {
        await api.leaveWaitlist(id);
        setWaitlist((list) => list.filter((e) => e.id !== id));
      } catch (e) {
        if (!api.signedIn) return onSessionEnded();
        setError(errorText(e, t));
      }
    },
    [api, t, onSessionEnded],
  );

  const removeFavorite = useCallback(
    async (slug: string) => {
      try {
        await api.removeFavorite(slug);
        setFavorites((list) => list?.filter((s) => s.slug !== slug) ?? null);
      } catch (e) {
        if (!api.signedIn) return onSessionEnded();
        setError(errorText(e, t));
      }
    },
    [api, t, onSessionEnded],
  );

  const closeVisit = useCallback(() => {
    setOpen(null);
    if (changed.current) {
      changed.current = false;
      void load();
    }
  }, [load]);
  const visitChanged = useCallback(() => {
    changed.current = true;
  }, []);

  if (open) {
    return (
      <VisitScreen
        api={api}
        t={t}
        locale={locale}
        visit={open}
        onBack={closeVisit}
        onBook={props.onBook}
        onChanged={visitChanged}
        onSessionEnded={onSessionEnded}
      />
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.screen}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
    >
      <View style={styles.header}>
        <Heading>{t.visits.title}</Heading>
        <Text style={styles.muted}>{fill(t.visits.signedInAs, { email: props.person.email })}</Text>
      </View>

      <View style={styles.tabs} accessibilityRole="tablist">
        {(['upcoming', 'past', 'bonuses', 'favorites'] as const).map((s) => (
          <Pressable
            key={s}
            accessibilityRole="tab"
            aria-selected={s === tab}
            onPress={() => setTab(s)}
            style={[styles.tab, s === tab && styles.tabActive]}
          >
            <Text style={[styles.tabText, s === tab && styles.tabTextActive]}>
              {s === 'upcoming'
                ? t.visits.upcoming
                : s === 'past'
                  ? t.visits.past
                  : s === 'bonuses'
                    ? t.bonuses.tab
                    : t.favorites.tab}
            </Text>
          </Pressable>
        ))}
      </View>

      {error ? (
        <View style={{ gap: 12 }}>
          <ErrorText>{error}</ErrorText>
          <Button kind="secondary" label={t.visits.refresh} onPress={load} />
        </View>
      ) : null}

      {tab === 'bonuses' && bonuses ? (
        <BonusesView t={t} locale={locale} items={bonuses} onBook={props.onBook} />
      ) : null}

      {tab === 'favorites' && favorites ? (
        <FavoritesView
          t={t}
          items={favorites}
          onOpen={props.onOpenSalon}
          onBook={props.onBook}
          onRemove={removeFavorite}
        />
      ) : null}

      {tab === 'upcoming' && waitlist.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.day}>{t.waitlist.title}</Text>
          {waitlist.map((entry) => (
            <Card key={entry.id}>
              <Text style={styles.service}>{entry.service.name}</Text>
              <Text style={styles.muted}>
                {formatDay(entry.date, locale)} · {entry.staff?.displayName ?? t.waitlist.any}
              </Text>
              <Text style={styles.salon}>{entry.salon.name}</Text>
              <Text style={entry.notifiedAt ? styles.notified : styles.muted}>
                {entry.notifiedAt ? t.waitlist.notified : t.waitlist.waiting}
              </Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Button
                  kind="link"
                  label={t.salon.book}
                  a11yLabel={`${t.salon.book}: ${entry.salon.name}`}
                  onPress={() =>
                    props.onBook(entry.salon.slug, entry.salon.name, {
                      serviceId: entry.service.id,
                      ...(entry.staff ? { staffId: entry.staff.id } : {}),
                    })
                  }
                />
                <Button
                  kind="link"
                  label={t.waitlist.leave}
                  a11yLabel={`${t.waitlist.leave}: ${entry.service.name}, ${formatDay(entry.date, locale)}`}
                  onPress={() => void leaveWaitlist(entry.id)}
                />
              </View>
            </Card>
          ))}
        </View>
      ) : null}

      {(tab === 'upcoming' || tab === 'past') && items && items.length === 0 ? (
        <Text style={styles.empty}>
          {tab === 'upcoming' ? t.visits.emptyUpcoming : t.visits.emptyPast}
        </Text>
      ) : null}

      {(tab === 'upcoming' || tab === 'past') && items
        ? groupByDay(items).map((group) => (
            <View key={group.date} style={{ gap: 8 }}>
              <Text style={styles.day}>{formatDay(group.date, locale)}</Text>
              {group.items.map((visit) => (
                <VisitCard
                  key={visit.id}
                  visit={visit}
                  t={t}
                  locale={locale}
                  onOpen={() => setOpen(visit)}
                />
              ))}
            </View>
          ))
        : null}

      <Button kind="secondary" label={t.catalog.title} onPress={props.onFindSalon} />
      <Button kind="link" label={t.visits.signOut} onPress={props.onSignOut} />
      <LanguageRow label={t.language} locale={locale} onLocale={props.onLocale} />
    </ScrollView>
  );
}

function VisitCard({
  visit,
  t,
  locale,
  onOpen,
}: {
  visit: ClientAppointment;
  t: Dictionary;
  locale: Locale;
  onOpen: () => void;
}) {
  const faded = visit.status === 'cancelled' || visit.status === 'expired';
  const address = salonAddress(visit.salon);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${visit.time} ${visit.service.name}, ${visit.salon.name}`}
      accessibilityHint={t.visit.open}
      onPress={onOpen}
      style={({ pressed }) => pressed && { opacity: 0.7 }}
    >
      <Card>
        <View style={styles.cardTop}>
          <Text style={[styles.time, faded && styles.faded]}>{visit.time}</Text>
          <Text
            style={[
              styles.badge,
              visit.status === 'confirmed' && styles.badgeOk,
              (visit.status === 'cancelled' || visit.status === 'no_show') && styles.badgeOff,
            ]}
          >
            {t.visits.status[visit.status]}
          </Text>
        </View>
        <Text style={[styles.service, faded && styles.faded]}>{visit.service.name}</Text>
        <Text style={styles.muted}>
          {fill(t.visits.with, { staff: visit.staff.displayName })} ·{' '}
          {visit.service.durationMinutes} {t.visits.minutes} ·{' '}
          {formatPrice(visit.service.priceGrosze, visit.currency, locale)}
        </Text>
        <Text style={styles.salon}>{visit.salon.name}</Text>
        {address ? <Text style={styles.muted}>{address}</Text> : null}
        <Text style={styles.more}>{t.visit.open} ›</Text>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 16 },
  header: { gap: 4 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  tabs: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabActive: { backgroundColor: colors.ink },
  tabText: { color: colors.ink, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  tabTextActive: { color: '#fff' },
  empty: { color: colors.muted, fontSize: 16, textAlign: 'center', paddingVertical: 32 },
  day: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 4,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  time: { fontSize: 22, fontWeight: '700', color: colors.ink },
  service: { fontSize: 17, fontWeight: '600', color: colors.ink },
  more: { color: colors.ink, fontSize: 14, fontWeight: '600', marginTop: 6 },
  salon: { fontSize: 15, fontWeight: '600', color: colors.ink, marginTop: 6 },
  faded: { color: colors.muted, textDecorationLine: 'line-through' },
  badge: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  badgeOk: { color: '#1e6b3a', borderColor: '#b9dcc4', backgroundColor: '#eef7f0' },
  badgeOff: { color: colors.danger, borderColor: '#efc6c2' },
  notified: { color: '#1e6b3a', fontSize: 14, fontWeight: '600' },
});
