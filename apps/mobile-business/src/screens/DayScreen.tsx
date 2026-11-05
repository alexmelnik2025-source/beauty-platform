import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type {
  BusinessApi,
  Calendar,
  Locale,
  PermissionCatalog,
  StaffList,
  TimeBlockList,
} from '../api';
import { blocksOfDay, blockTargets, canRemoveBlock } from '../blocks';
import { addDays, dayTitle, myStaffId, onlyMine, staffOfDay, todayIn, visitsOfDay } from '../day';
import { errorText } from '../errors';
import { badge } from '../notifications';
import type { Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading } from '../ui';
import { BlockScreen } from './BlockScreen';
import { NotificationsScreen } from './NotificationsScreen';
import { ProfileScreen } from './ProfileScreen';
import { ClientsScreen } from './ClientsScreen';
import { mayAddVisits, type MyRights } from '../newVisit';
import { NewVisitScreen } from './NewVisitScreen';
import type { SalonChoice } from './SalonsScreen';
import { ReportsScreen } from './ReportsScreen';
import { TeamScreen } from './TeamScreen';
import { ScheduleScreen } from './ScheduleScreen';
import { SalonScreen } from './SalonScreen';
import { maySeeSalon } from '../salon';
import { TeamHoursScreen } from './TeamHoursScreen';
import { VisitScreen } from './VisitScreen';

const REFRESH_MS = 30_000;

/** One day of the salon's calendar; a specialist sees their own visits (the server decides). */
export function DayScreen(props: {
  api: BusinessApi;
  t: Dictionary;
  locale: Locale;
  salon: SalonChoice;
  timeZone: string;
  canChangeSalon: boolean;
  onChangeSalon: () => void;
  onSignOut: () => void;
}) {
  const { api, t, salon } = props;
  const today = todayIn(props.timeZone);
  const [date, setDate] = useState(today);
  const [calendar, setCalendar] = useState<Calendar | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [teamHoursOpen, setTeamHoursOpen] = useState(false);
  const [clientsOpen, setClientsOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [blocks, setBlocks] = useState<{ date: string; list: TimeBlockList } | null>(null);
  const [staffList, setStaffList] = useState<StaffList>([]);
  const [myPerms, setMyPerms] = useState<PermissionCatalog['me'] | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [info, setInfo] = useState('');
  const [canChange, setCanChange] = useState(salon.role !== 'staff');
  const [mineId, setMineId] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [rights, setRights] = useState<MyRights | null>(null);
  const [adding, setAdding] = useState(false);
  const [canReport, setCanReport] = useState(salon.role !== 'staff');
  const [reportsOpen, setReportsOpen] = useState(false);
  const [salonOpen, setSalonOpen] = useState(false);
  const [salonName, setSalonName] = useState(salon.locationName);

  // Once per salon: may this person mark visits, and are they one of the specialists?
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [perms, me, staff] = await Promise.allSettled([
        api.permissions(salon.orgId),
        api.me(),
        api.staff(salon.orgId, salon.locationId),
      ]);
      if (!alive) return;
      if (perms.status === 'fulfilled') {
        const p = perms.value.me;
        setMyPerms(p);
        setRights(p);
        setCanChange(p.role !== 'staff' || p.permissions.changeOwnAppointments);
        // Reports: the whole salon for owners and managers, own results with the permission.
        setCanReport(p.role !== 'staff' || p.permissions.viewOwnEarnings);
      }
      if (staff.status === 'fulfilled') setStaffList(staff.value);
      if (me.status === 'fulfilled' && staff.status === 'fulfilled') {
        setMineId(myStaffId(staff.value, me.value.user.id));
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, salon]);

  // Only the newest answer is shown: tapping through days quickly must not leave an older day.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    try {
      const [day, dayBlocks, bell] = await Promise.all([
        api.calendar(salon.orgId, salon.locationId, date),
        api.timeBlocks(salon.orgId, salon.locationId, date).catch(() => null),
        api.unreadNotifications().catch(() => null),
      ]);
      if (request !== latest.current) return;
      if (bell) setUnread(bell.unread);
      setCalendar(day);
      setBlocks(dayBlocks ? { date, list: dayBlocks } : null);
      setError('');
    } catch (e) {
      if (request === latest.current) setError(errorText(e, t));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [api, salon, date, t]);

  useEffect(() => {
    setCalendar(null);
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const all = calendar && calendar.from === date ? visitsOfDay(calendar, date) : null;
  // "Only mine" is for an owner or manager who also works as a specialist;
  // a specialist's calendar already holds just their own visits (the server decides).
  const showMineSwitch = salon.role !== 'staff' && mineId !== null;
  const visits = all && showMineSwitch && mineOnly ? onlyMine(all, mineId) : all;

  if (reportsOpen) {
    return (
      <ReportsScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        today={today}
        onBack={() => setReportsOpen(false)}
      />
    );
  }

  if (teamHoursOpen) {
    return (
      <TeamHoursScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        today={today}
        onBack={() => {
          setTeamHoursOpen(false);
          void load();
        }}
      />
    );
  }

  if (scheduleOpen && mineId) {
    return (
      <ScheduleScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        staffId={mineId}
        today={today}
        onBack={() => setScheduleOpen(false)}
      />
    );
  }

  const targets = myPerms ? blockTargets(myPerms, staffList, mineId) : [];

  if (adding && rights) {
    return (
      <NewVisitScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        timeZone={props.timeZone}
        today={today}
        date={date}
        me={rights}
        mineId={mineId}
        onBack={() => setAdding(false)}
        onCreated={(visit) => {
          // The new visit's card, and its day behind it.
          // Another day loads by itself; the same day is read again (an older answer for the
          // previous day must not arrive after the new one).
          setAdding(false);
          setOpenId(visit.id);
          if (visit.date === date) void load();
          else setDate(visit.date);
        }}
      />
    );
  }

  if (profileOpen && mineId) {
    return (
      <ProfileScreen
        api={api}
        t={t}
        salon={salon}
        staffId={mineId}
        onBack={() => setProfileOpen(false)}
      />
    );
  }

  if (bellOpen) {
    return (
      <NotificationsScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        timeZone={props.timeZone}
        canChange={canChange}
        onBack={() => {
          setBellOpen(false);
          void load();
        }}
      />
    );
  }

  if (blockOpen) {
    return (
      <BlockScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        date={date}
        today={today}
        timeZone={props.timeZone}
        targets={targets}
        onBack={() => setBlockOpen(false)}
        onSaved={() => {
          setBlockOpen(false);
          setInfo(t.blocks.added);
          void load();
        }}
      />
    );
  }

  if (salonOpen) {
    return (
      <SalonScreen
        api={api}
        t={t}
        salon={salon}
        onBack={() => setSalonOpen(false)}
        onRenamed={setSalonName}
      />
    );
  }

  if (teamOpen) {
    return (
      <TeamScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        timeZone={props.timeZone}
        onBack={() => setTeamOpen(false)}
      />
    );
  }

  if (clientsOpen) {
    return (
      <ClientsScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        timeZone={props.timeZone}
        onBack={() => setClientsOpen(false)}
      />
    );
  }

  if (openId) {
    return (
      <VisitScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        id={openId}
        timeZone={props.timeZone}
        canChange={canChange}
        onBack={() => setOpenId(null)}
        onChanged={() => void load()}
      />
    );
  }
  const working = calendar && calendar.from === date ? staffOfDay(calendar, date) : [];
  const dayBlocks =
    blocks && blocks.date === date ? blocksOfDay(blocks.list, staffList, date, props.timeZone) : [];

  async function unblock(id: string) {
    setRemoveId(null);
    try {
      await api.removeTimeBlock(salon.orgId, salon.locationId, id);
      setInfo(t.blocks.removed);
      await load();
    } catch (e) {
      setError(errorText(e, t));
    }
  }

  return (
    <ScrollView
      contentContainerStyle={styles.screen}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
    >
      <View style={styles.top}>
        <Text style={styles.salon}>{salonName}</Text>
        <View style={styles.row}>
          {props.canChangeSalon ? (
            <Button kind="link" label={t.changeSalon} onPress={props.onChangeSalon} />
          ) : null}
          <Button
            kind="link"
            label={unread > 0 ? `${t.notifications.open} (${badge(unread)})` : t.notifications.open}
            onPress={() => setBellOpen(true)}
          />
          {salon.role !== 'staff' ? (
            <Button kind="link" label={t.clients.open} onPress={() => setClientsOpen(true)} />
          ) : null}
          {salon.role !== 'staff' ? (
            <Button kind="link" label={t.team.open} onPress={() => setTeamOpen(true)} />
          ) : null}
          {maySeeSalon(salon.role) ? (
            <Button kind="link" label={t.salon.open} onPress={() => setSalonOpen(true)} />
          ) : null}
          {mineId ? (
            <Button kind="link" label={t.schedule.open} onPress={() => setScheduleOpen(true)} />
          ) : null}
          {salon.role !== 'staff' ? (
            <Button
              kind="link"
              label={t.schedule.teamOpen}
              onPress={() => setTeamHoursOpen(true)}
            />
          ) : null}
          {canReport ? (
            <Button kind="link" label={t.reports.open} onPress={() => setReportsOpen(true)} />
          ) : null}
          {mineId ? (
            <Button kind="link" label={t.profile.open} onPress={() => setProfileOpen(true)} />
          ) : null}
          <Button kind="link" label={t.signOut} onPress={props.onSignOut} />
        </View>
      </View>

      <Heading>{dayTitle(date, props.locale)}</Heading>
      <View style={styles.row}>
        <Button
          kind="secondary"
          label="‹"
          a11yLabel={t.day.previous}
          onPress={() => setDate(addDays(date, -1))}
        />
        <Button
          kind="secondary"
          label={t.day.today}
          onPress={() => setDate(today)}
          disabled={date === today}
        />
        <Button
          kind="secondary"
          label="›"
          a11yLabel={t.day.next}
          onPress={() => setDate(addDays(date, 1))}
        />
        <Button kind="link" label={t.day.refresh} onPress={load} />
      </View>
      {rights && mayAddVisits(rights, mineId) ? (
        <Button label={t.newVisit.open} onPress={() => setAdding(true)} />
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {info ? <Text style={styles.info}>{info}</Text> : null}

      {visits ? (
        <>
          <Text style={styles.section}>{t.day.working}</Text>
          <Text style={styles.muted}>
            {working.length === 0
              ? t.day.nobodyWorks
              : working.map((w) => `${w.name} ${w.hours}`).join(' · ')}
          </Text>

          {dayBlocks.length > 0 || targets.length > 0 ? (
            <View style={[styles.row, styles.sectionRow]}>
              <Text style={styles.section}>{t.blocks.title}</Text>
              {targets.length > 0 ? (
                <Button
                  kind="link"
                  label={`+ ${t.blocks.add}`}
                  onPress={() => {
                    setInfo('');
                    setBlockOpen(true);
                  }}
                />
              ) : null}
            </View>
          ) : null}
          {dayBlocks.map((block) => (
            <View key={block.id} style={styles.block}>
              <Text style={styles.blockTime}>
                {block.start}–{block.end} · {block.staff ?? t.blocks.wholeSalon}
              </Text>
              {block.reason ? <Text style={styles.muted}>{block.reason}</Text> : null}
              {canRemoveBlock(block, targets) ? (
                removeId === block.id ? (
                  <View style={styles.row}>
                    <Text style={styles.muted}>{t.blocks.removeAsk}</Text>
                    <Button label={t.blocks.yes} onPress={() => void unblock(block.id)} />
                    <Button
                      kind="secondary"
                      label={t.blocks.no}
                      onPress={() => setRemoveId(null)}
                    />
                  </View>
                ) : (
                  <View style={styles.row}>
                    <Button
                      kind="link"
                      label={t.blocks.remove}
                      a11yLabel={`${t.blocks.remove} ${block.start}–${block.end}`}
                      onPress={() => setRemoveId(block.id)}
                    />
                  </View>
                )
              ) : null}
            </View>
          ))}

          <View style={[styles.row, styles.sectionRow]}>
            <Text style={styles.section}>
              {t.day.visits} ({visits.length})
            </Text>
            {showMineSwitch ? (
              <Button
                kind="link"
                label={mineOnly ? t.day.everyone : t.day.onlyMine}
                onPress={() => setMineOnly(!mineOnly)}
              />
            ) : null}
          </View>
          {visits.length === 0 ? <Text style={styles.muted}>{t.day.empty}</Text> : null}
          {visits.map((v) => (
            <Pressable
              key={v.id}
              accessibilityRole="button"
              accessibilityLabel={`${v.start} ${v.customer ?? t.day.walkIn} · ${v.service}`}
              onPress={() => setOpenId(v.id)}
              style={({ pressed }) => pressed && { opacity: 0.7 }}
            >
              <Card>
                <View style={styles.cardTop}>
                  <Text style={styles.time}>
                    {v.start}–{v.end}
                  </Text>
                  <Text style={[styles.badge, v.status === 'no_show' && styles.badgeBad]}>
                    {t.day.status[v.status as keyof Dictionary['day']['status']] ?? v.status}
                  </Text>
                </View>
                <Text style={styles.customer}>{v.customer ?? t.day.walkIn}</Text>
                <Text style={styles.muted}>
                  {v.service} · {v.staff}
                </Text>
                {v.phone ? <Text style={styles.muted}>{v.phone}</Text> : null}
              </Card>
            </Pressable>
          ))}
        </>
      ) : !error ? (
        <Text style={styles.muted}>{t.loading}</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  salon: { color: colors.gold, fontWeight: '700', fontSize: 15, flexShrink: 1 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  sectionRow: { justifyContent: 'space-between', marginTop: 8 },
  section: { marginTop: 8, fontSize: 13, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  muted: { color: colors.muted, fontSize: 15 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  time: { fontSize: 18, fontWeight: '700', color: colors.ink },
  badge: {
    fontSize: 12,
    color: colors.ink,
    backgroundColor: '#efe7d8',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
  badgeBad: { backgroundColor: '#f6dcd9', color: colors.danger },
  customer: { fontSize: 17, fontWeight: '600', color: colors.ink },
  info: { color: '#2e7d32', fontSize: 15 },
  block: {
    backgroundColor: '#ece9e3',
    borderRadius: 12,
    padding: 12,
    gap: 4,
    borderLeftWidth: 4,
    borderLeftColor: colors.muted,
  },
  blockTime: { fontSize: 16, fontWeight: '600', color: colors.ink },
});
