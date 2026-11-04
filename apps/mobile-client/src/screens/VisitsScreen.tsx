import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ClientApi, ClientAppointment, ClientPerson, Locale, Scope } from '../api';
import { errorText } from '../errors';
import { formatDay, formatPrice, groupByDay, salonAddress } from '../format';
import { fill, type Dictionary } from '../i18n';
import { LanguageRow } from '../LanguageRow';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import { VisitScreen } from './VisitScreen';

/** "My visits": upcoming and past visits in every salon, found by the client's email. */
export function VisitsScreen(props: {
  api: ClientApi;
  t: Dictionary;
  locale: Locale;
  person: ClientPerson;
  onLocale: (locale: Locale) => void;
  /** Opens the catalogue of salons (no sign-in needed). */
  onFindSalon: () => void;
  onSignOut: () => void;
  /** The server no longer accepts the session (signed out elsewhere, or it ended). */
  onSessionEnded: () => void;
}) {
  const { api, t, locale, onSessionEnded } = props;
  const [scope, setScope] = useState<Scope>('upcoming');
  const [items, setItems] = useState<ClientAppointment[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<ClientAppointment | null>(null);
  const changed = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems((await api.appointments(scope)).items);
      setError('');
    } catch (e) {
      if (!api.signedIn) return onSessionEnded();
      setError(errorText(e, t));
    } finally {
      setLoading(false);
    }
  }, [api, scope, t, onSessionEnded]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

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
        {(['upcoming', 'past'] as const).map((s) => (
          <Pressable
            key={s}
            accessibilityRole="tab"
            aria-selected={s === scope}
            onPress={() => setScope(s)}
            style={[styles.tab, s === scope && styles.tabActive]}
          >
            <Text style={[styles.tabText, s === scope && styles.tabTextActive]}>
              {s === 'upcoming' ? t.visits.upcoming : t.visits.past}
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

      {items && items.length === 0 ? (
        <Text style={styles.empty}>
          {scope === 'upcoming' ? t.visits.emptyUpcoming : t.visits.emptyPast}
        </Text>
      ) : null}

      {items
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
          {formatPrice(visit.service.priceGrosze, locale)}
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
  tab: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center' },
  tabActive: { backgroundColor: colors.ink },
  tabText: { color: colors.ink, fontSize: 15, fontWeight: '600' },
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
});
