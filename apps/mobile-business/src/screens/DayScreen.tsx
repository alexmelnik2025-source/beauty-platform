import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Platform,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type {
  BusinessApi,
  Calendar,
  Locale,
  PermissionCatalog,
  SalonReport,
  StaffList,
  TimeBlockList,
} from '../api';
import { blocksOfDay, blockTargets, canRemoveBlock } from '../blocks';
import {
  addDays,
  dayTitle,
  calendarDate,
  formatPrice,
  myStaffId,
  onlyMine,
  staffOfDay,
  todayIn,
  visitsOfDay,
} from '../day';
import { tillOf } from '../till';
import { dayPlanText } from '../dayPlan';
import { shareText, type TextShareTools } from '../share';
import { errorText } from '../errors';
import { badge } from '../notifications';
import { fill, type Dictionary } from '../i18n';
import { Button, Card, colors, ErrorText, Heading, Pressable } from '../ui';
import { LanguagePicker } from './LanguagePicker';
import { BlockScreen } from './BlockScreen';
import { NotificationsScreen } from './NotificationsScreen';
import { ProfileScreen } from './ProfileScreen';
import { ClientsScreen } from './ClientsScreen';
import { mayAddVisits, type MyRights } from '../newVisit';
import { NewVisitScreen } from './NewVisitScreen';
import type { SalonChoice } from './SalonsScreen';
import { ReportsScreen } from './ReportsScreen';
import { HappyHoursScreen } from './HappyHoursScreen';
import { LoyaltyScreen } from './LoyaltyScreen';
import { ServicesScreen } from './ServicesScreen';
import { TeamScreen } from './TeamScreen';
import { HistoryScreen } from './HistoryScreen';
import { ReviewsScreen } from './ReviewsScreen';
import { BookingLinkScreen } from './BookingLinkScreen';
import { GuardScreen } from './GuardScreen';
import { VouchersScreen } from './VouchersScreen';
import { MyShopScreen } from './MyShopScreen';
import { mayManageGuard } from '../guard';
import { mayViewHistory } from '../history';
import { mayManageLoyalty } from '../loyalty';
import { ScheduleScreen } from './ScheduleScreen';
import { SalonScreen } from './SalonScreen';
import { MessagesScreen } from './MessagesScreen';
import { maySeeSalon } from '../salon';
import { TeamHoursScreen } from './TeamHoursScreen';
import { VisitScreen } from './VisitScreen';
import { WeekScreen } from './WeekScreen';
import { WaitlistSection } from './WaitlistSection';
import { TillCloseSection, TillReminder } from './TillCloseSection';
import { ClientsNowCard } from './ClientsNowCard';
import { SetupCard } from './SetupCard';
import { presetFromEntry, type NewVisitPreset } from '../waitlist';

type MainTab = 'calendar' | 'clients' | 'shop' | 'more';

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
  onLocale: (locale: Locale) => void;
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
  const [tab, setTab] = useState<MainTab>('calendar');
  const [teamOpen, setTeamOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const [guardOpen, setGuardOpen] = useState(false);
  const [vouchersOpen, setVouchersOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [happyOpen, setHappyOpen] = useState(false);
  const [loyaltyOpen, setLoyaltyOpen] = useState(false);
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
  const [staffId, setStaffId] = useState<string | null>(null);
  const [staffPicker, setStaffPicker] = useState(false);
  const [rights, setRights] = useState<MyRights | null>(null);
  const [adding, setAdding] = useState(false);
  const [canReport, setCanReport] = useState(salon.role !== 'staff');
  const [reportsOpen, setReportsOpen] = useState(false);
  const [weekOpen, setWeekOpen] = useState(false);
  const [salonOpen, setSalonOpen] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [salonName, setSalonName] = useState(salon.locationName);
  const [preset, setPreset] = useState<NewVisitPreset | null>(null);
  const [reloads, setReloads] = useState(0);
  /** Task 228: "Kasa dnia" — the report of the shown day. */
  const [dayReport, setDayReport] = useState<SalonReport | null>(null);

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
      const day = api.calendar(salon.orgId, salon.locationId, date);
      void api.timeBlocks(salon.orgId, salon.locationId, date).then(
        (list) => {
          if (request === latest.current) setBlocks({ date, list });
        },
        () => {
          if (request === latest.current) setBlocks(null);
        },
      );
      void api.unreadNotifications().then(
        ({ unread }) => {
          if (request === latest.current) setUnread(unread);
        },
        () => undefined,
      );
      const currentDay = await day;
      if (request !== latest.current) return;
      setCalendar(currentDay);
      setReloads((n) => n + 1);
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

  // Task 228: "Kasa dnia" for today and past days, once for each loaded calendar.
  useEffect(() => {
    if (!canReport || calendar?.from !== date || date > today) {
      setDayReport(null);
      return;
    }
    let alive = true;
    api
      .report(salon.orgId, salon.locationId, date, date)
      .then((r) => {
        if (alive) setDayReport(r);
      })
      .catch(() => {
        if (alive) setDayReport(null);
      });
    return () => {
      alive = false;
    };
  }, [api, salon, date, today, canReport, calendar]);
  const till = tillOf(dayReport, date);

  const all = calendar && calendar.from === date ? visitsOfDay(calendar, date) : null;
  const canBrowseSalon = salon.role !== 'staff';
  const selectedStaff = staffList.find((staff) => staff.id === staffId);
  const staffLabel = canBrowseSalon
    ? (selectedStaff?.displayName ?? t.navigation.allStaff)
    : (staffList.find((staff) => staff.id === mineId)?.displayName ?? t.navigation.myCalendar);
  const visits = all ? onlyMine(all, canBrowseSalon ? staffId : null) : null;

  useEffect(() => {
    if (tab !== 'more') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setTab('calendar');
      return true;
    });
    return () => sub.remove();
  }, [tab]);

  function withNavigation(content: ReactNode) {
    const tabs: { id: MainTab; icon: string; label: string }[] = [
      { id: 'calendar', icon: '▦', label: t.navigation.calendar },
      ...(canBrowseSalon
        ? [
            { id: 'clients' as const, icon: '♙', label: t.clients.open },
            { id: 'shop' as const, icon: '▣', label: t.shop.open },
          ]
        : []),
      { id: 'more', icon: '⋯', label: t.navigation.more },
    ];
    return (
      <View style={styles.shell}>
        <View style={styles.shell}>{content}</View>
        <View style={styles.tabBar} accessibilityRole="tablist">
          {tabs.map(({ id, icon, label }) => (
            <Pressable
              key={id}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: tab === id }}
              aria-selected={tab === id}
              onPress={() => {
                setStaffPicker(false);
                setTab(id);
              }}
              style={[styles.tab, tab === id && styles.tabSelected]}
            >
              <Text aria-hidden style={styles.tabIcon}>
                {icon}
              </Text>
              <Text style={styles.tabLabel}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }

  if (weekOpen) {
    return (
      <WeekScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        date={date}
        today={today}
        onOpenDay={(day) => {
          setDate(day);
          setWeekOpen(false);
        }}
        onBack={() => setWeekOpen(false)}
      />
    );
  }

  if (reportsOpen) {
    return (
      <ReportsScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        today={today}
        timeZone={props.timeZone}
        onBack={() => setReportsOpen(false)}
        onOpenDay={(day) => {
          setDate(day);
          setReportsOpen(false);
          setTab('calendar');
        }}
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
        preset={preset ?? undefined}
        onBack={() => {
          setAdding(false);
          setPreset(null);
        }}
        onCreated={(visit) => {
          // The new visit's card, and its day behind it.
          // Another day loads by itself; the same day is read again (an older answer for the
          // previous day must not arrive after the new one).
          setAdding(false);
          setPreset(null);
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
        onSaved={(message) => {
          setBlockOpen(false);
          setInfo(message);
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
        locale={props.locale}
        salon={salon}
        onBack={() => setSalonOpen(false)}
        onRenamed={setSalonName}
      />
    );
  }

  if (messagesOpen) {
    return <MessagesScreen api={api} t={t} salon={salon} onBack={() => setMessagesOpen(false)} />;
  }

  if (happyOpen) {
    return (
      <HappyHoursScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        onBack={() => setHappyOpen(false)}
      />
    );
  }

  if (loyaltyOpen) {
    return (
      <LoyaltyScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        timeZone={props.timeZone}
        onBack={() => setLoyaltyOpen(false)}
      />
    );
  }

  if (servicesOpen) {
    return (
      <ServicesScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        onBack={() => setServicesOpen(false)}
      />
    );
  }

  if (guardOpen) {
    return (
      <GuardScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        onBack={() => setGuardOpen(false)}
      />
    );
  }

  if (vouchersOpen) {
    return (
      <VouchersScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        onBack={() => setVouchersOpen(false)}
      />
    );
  }

  if (linkOpen) {
    return <BookingLinkScreen api={api} t={t} salon={salon} onBack={() => setLinkOpen(false)} />;
  }

  if (tab === 'shop') {
    return withNavigation(
      <MyShopScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        onBack={() => setTab('calendar')}
      />,
    );
  }

  if (reviewsOpen) {
    return (
      <ReviewsScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        timeZone={props.timeZone}
        onBack={() => setReviewsOpen(false)}
      />
    );
  }

  if (historyOpen) {
    return (
      <HistoryScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        timeZone={props.timeZone}
        onBack={() => setHistoryOpen(false)}
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

  if (tab === 'clients') {
    return withNavigation(
      <ClientsScreen
        api={api}
        t={t}
        locale={props.locale}
        salon={salon}
        timeZone={props.timeZone}
        onBack={() => setTab('calendar')}
      />,
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
        onBookAgain={
          rights && mayAddVisits(rights, mineId)
            ? (next) => {
                // Task 223: the new-visit form with the same client, service and specialist.
                setOpenId(null);
                setPreset(next);
                setAdding(true);
              }
            : undefined
        }
      />
    );
  }
  const working =
    calendar && calendar.from === date
      ? staffOfDay(calendar, date, canBrowseSalon ? staffId : null)
      : [];
  const dayBlocks =
    blocks && blocks.date === date
      ? blocksOfDay(blocks.list, staffList, date, props.timeZone).filter(
          (block) => !staffId || !block.staffId || block.staffId === staffId,
        )
      : [];

  /** Task 351: the day as text for the team chat or printing — the list as it is on the screen. */
  async function sharePlan() {
    if (!visits) return;
    const title = dayTitle(date, props.locale);
    const message = dayPlanText(
      { salon: salonName, title, visits, working, blocks: dayBlocks },
      {
        working: t.day.working,
        nobodyWorks: t.day.nobodyWorks,
        empty: t.day.empty,
        blocks: t.blocks.title,
        wholeSalon: t.blocks.wholeSalon,
        walkIn: t.day.walkIn,
        awaitingApproval: t.visit.awaitingApproval,
      },
    );
    const result = await shareText({ title: `${salonName} — ${title}`, message }, textShareTools());
    setInfo(result === 'copied' ? t.day.planCopied : result === 'failed' ? t.day.planFailed : '');
  }

  async function unblock(id: string, seriesId?: string) {
    setRemoveId(null);
    try {
      if (seriesId) await api.removeTimeBlockSeries(salon.orgId, salon.locationId, seriesId);
      else await api.removeTimeBlock(salon.orgId, salon.locationId, id);
      setInfo(seriesId ? t.blocks.seriesRemoved : t.blocks.removed);
      await load();
    } catch (e) {
      setError(errorText(e, t));
    }
  }

  if (tab === 'more') {
    const items = [
      { label: t.notifications.open, open: () => setBellOpen(true), visible: true },
      { label: t.services.open, open: () => setServicesOpen(true), visible: canBrowseSalon },
      { label: t.happyHours.open, open: () => setHappyOpen(true), visible: canBrowseSalon },
      { label: t.team.open, open: () => setTeamOpen(true), visible: canBrowseSalon },
      { label: t.schedule.teamOpen, open: () => setTeamHoursOpen(true), visible: canBrowseSalon },
      { label: t.schedule.open, open: () => setScheduleOpen(true), visible: !!mineId },
      { label: t.reports.open, open: () => setReportsOpen(true), visible: canReport },
      {
        label: t.loyalty.open,
        open: () => setLoyaltyOpen(true),
        visible: mayManageLoyalty(salon.role),
      },
      { label: t.guard.open, open: () => setGuardOpen(true), visible: mayManageGuard(salon.role) },
      { label: t.reviews.open, open: () => setReviewsOpen(true), visible: true },
      { label: t.vouchers.open, open: () => setVouchersOpen(true), visible: true },
      {
        label: t.history.open,
        open: () => setHistoryOpen(true),
        visible: mayViewHistory(salon.role),
      },
      { label: t.bookingLink.open, open: () => setLinkOpen(true), visible: canBrowseSalon },
      {
        label: t.messages.open,
        open: () => setMessagesOpen(true),
        visible: maySeeSalon(salon.role),
      },
      {
        label: t.navigation.settings,
        open: () => setSalonOpen(true),
        visible: maySeeSalon(salon.role),
      },
      { label: t.profile.open, open: () => setProfileOpen(true), visible: !!mineId },
      { label: t.changeSalon, open: props.onChangeSalon, visible: props.canChangeSalon },
    ];
    return withNavigation(
      <ScrollView contentContainerStyle={styles.screen}>
        <View style={styles.top}>
          <Heading>{t.navigation.more}</Heading>
          <LanguagePicker t={t} locale={props.locale} onLocale={props.onLocale} />
        </View>
        <Card>
          {items
            .filter((item) => item.visible)
            .map(({ label, open }) => (
              <Pressable
                accessibilityLabel={label}
                key={label}
                accessibilityRole="button"
                onPress={open}
                style={styles.menuItem}
              >
                <Text style={styles.menuText}>{label}</Text>
                <Text aria-hidden style={styles.muted}>
                  ›
                </Text>
              </Pressable>
            ))}
        </Card>
        <Button kind="link" label={t.signOut} onPress={props.onSignOut} />
      </ScrollView>,
    );
  }

  return withNavigation(
    <ScrollView
      contentContainerStyle={styles.screen}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
    >
      <View style={styles.top}>
        <Text style={styles.salon}>{salonName}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            unread > 0 ? `${t.notifications.open} (${badge(unread)})` : t.notifications.open
          }
          onPress={() => setBellOpen(true)}
          style={styles.compactButton}
        >
          <Text style={styles.menuText}>🔔{unread > 0 ? ` ${badge(unread)}` : ''}</Text>
        </Pressable>
      </View>
      <View style={styles.dateBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.day.previous}
          onPress={() => setDate((current) => addDays(current, -1))}
          style={styles.compactButton}
        >
          <Text style={styles.menuText}>‹</Text>
        </Pressable>
        <Text
          accessibilityRole="header"
          accessibilityLabel={dayTitle(date, props.locale)}
          style={styles.dateLabel}
        >
          {calendarDate(date, props.locale)}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.day.next}
          onPress={() => setDate((current) => addDays(current, 1))}
          style={styles.compactButton}
        >
          <Text style={styles.menuText}>›</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={t.day.today}
          accessibilityRole="button"
          accessibilityState={{ disabled: date === today }}
          onPress={() => setDate(today)}
          disabled={date === today}
          style={styles.compactButton}
        >
          <Text style={[styles.menuText, date === today && styles.muted]}>{t.day.today}</Text>
        </Pressable>
        {canBrowseSalon && staffList.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t.navigation.specialist}: ${staffLabel}`}
            accessibilityState={{ expanded: staffPicker }}
            aria-expanded={staffPicker}
            onPress={() => setStaffPicker(!staffPicker)}
            style={[styles.compactButton, styles.staffButton]}
          >
            <Text style={styles.menuText}>{staffLabel} ▾</Text>
          </Pressable>
        ) : (
          <Text style={[styles.menuText, styles.staffButton]}>{staffLabel}</Text>
        )}
      </View>
      {staffPicker ? (
        <Card>
          {[{ id: null, displayName: t.navigation.allStaff }, ...staffList].map((staff) => (
            <Pressable
              accessibilityLabel={staff.displayName}
              key={staff.id ?? 'all'}
              accessibilityRole="button"
              accessibilityState={{ selected: staffId === staff.id }}
              onPress={() => {
                setStaffId(staff.id);
                setStaffPicker(false);
              }}
              style={styles.menuItem}
            >
              <Text style={styles.menuText}>{staff.displayName}</Text>
              {staffId === staff.id ? <Text aria-hidden>✓</Text> : null}
            </Pressable>
          ))}
        </Card>
      ) : null}
      <View style={styles.row}>
        <Button kind="link" label={t.week.open} onPress={() => setWeekOpen(true)} />
        <Button kind="link" label={t.day.refresh} onPress={load} />
        {visits ? (
          <Button kind="link" label={t.day.sharePlan} onPress={() => void sharePlan()} />
        ) : null}
      </View>
      {rights && mayAddVisits(rights, mineId) ? (
        <Button label={t.newVisit.open} onPress={() => setAdding(true)} />
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {info ? <Text style={styles.info}>{info}</Text> : null}

      {maySeeSalon(salon.role) ? (
        <SetupCard
          api={api}
          t={t}
          salon={salon}
          onOpen={(step) => {
            setInfo('');
            if (step === 'services') setServicesOpen(true);
            else if (step === 'team' || step === 'hours') setTeamHoursOpen(true);
            else setSalonOpen(true);
          }}
        />
      ) : null}
      {salon.role !== 'staff' && date === today ? (
        <ClientsNowCard api={api} t={t} locale={props.locale} salon={salon} reloads={reloads} />
      ) : null}
      {salon.role !== 'staff' && date === today ? (
        <TillReminder
          api={api}
          t={t}
          locale={props.locale}
          salon={salon}
          today={today}
          reloads={reloads}
          onOpen={setDate}
        />
      ) : null}

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
              {block.seriesId ? <Text style={styles.muted}>{t.blocks.weekly}</Text> : null}
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
                ) : block.seriesId && removeId === `series:${block.id}` ? (
                  <View style={styles.row}>
                    <Text style={styles.muted}>{t.blocks.removeSeriesAsk}</Text>
                    <Button
                      label={t.blocks.removeSeriesYes}
                      onPress={() => void unblock(block.id, block.seriesId ?? undefined)}
                    />
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
                    {block.seriesId ? (
                      <Button
                        kind="link"
                        label={t.blocks.removeSeries}
                        a11yLabel={`${t.blocks.removeSeries} ${block.start}–${block.end}`}
                        onPress={() => setRemoveId(`series:${block.id}`)}
                      />
                    ) : null}
                  </View>
                )
              ) : null}
            </View>
          ))}

          <View style={[styles.row, styles.sectionRow]}>
            <Text style={styles.section}>
              {t.day.visits} ({visits.length})
            </Text>
          </View>
          {till ? (
            <View style={styles.till} testID="till" accessibilityRole="summary">
              <Text style={styles.tillTotal}>
                {fill(t.day.till, {
                  amount: formatPrice(till.revenueGrosze, till.currency, props.locale),
                })}
                {till.own ? ` · ${t.day.tillOwn}` : ''}
              </Text>
              {till.methods.length > 0 ? (
                <Text style={styles.muted}>
                  {till.methods
                    .map(
                      (m) =>
                        `${m.method === 'unknown' ? t.reports.paymentsUnknown : t.visit.paymentMethods[m.method]} ${formatPrice(m.revenueGrosze, till.currency, props.locale)}`,
                    )
                    .join(' · ')}
                </Text>
              ) : null}
              {till.tipsGrosze > 0 ? (
                <Text style={styles.muted} testID="till-tips">
                  {fill(t.day.tillTips, {
                    amount: formatPrice(till.tipsGrosze, till.currency, props.locale),
                  })}
                </Text>
              ) : null}
              {till.unpaid > 0 ? (
                <Text style={styles.tillUnpaid}>
                  {fill(t.day.tillUnpaid, { n: String(till.unpaid) })}
                </Text>
              ) : null}
              {till.own ? null : (
                // Task 232: "Zamknij kasę" — owners and managers (the whole salon's till).
                <TillCloseSection
                  api={api}
                  t={t}
                  locale={props.locale}
                  salon={salon}
                  date={date}
                  timeZone={props.timeZone}
                  reloads={reloads}
                />
              )}
            </View>
          ) : null}
          {visits.length === 0 ? <Text style={styles.muted}>{t.day.empty}</Text> : null}
          {visits.map((v) => (
            <Pressable
              key={v.id}
              accessibilityRole="button"
              accessibilityLabel={`${v.start} ${v.waiting ? '⏳ ' : ''}${v.birthday ? '🎂 ' : ''}${v.customer ?? t.day.walkIn} · ${v.service}`}
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
                <Text style={styles.customer}>
                  {v.waiting ? '⏳ ' : ''}
                  {v.birthday ? '🎂 ' : ''}
                  {v.customer ?? t.day.walkIn}
                </Text>
                <Text style={styles.muted}>
                  {v.service} · {v.staff}
                </Text>
                {v.phone ? <Text style={styles.muted}>{v.phone}</Text> : null}
              </Card>
            </Pressable>
          ))}

          {salon.role !== 'staff' && rights ? (
            <WaitlistSection
              api={api}
              t={t}
              salon={salon}
              date={date}
              today={today}
              timeZone={props.timeZone}
              reload={reloads}
              onBook={(entry) => {
                setPreset(presetFromEntry(entry));
                setAdding(true);
              }}
            />
          ) : null}
        </>
      ) : !error ? (
        <Text style={styles.muted}>{t.loading}</Text>
      ) : null}
    </ScrollView>,
  );
}

/** Task 351: the share sheet on phones; in the web preview the browser's menu or the clipboard. */
function textShareTools(): TextShareTools {
  if (Platform.OS !== 'web') {
    return { native: (c) => Share.share({ message: c.message, title: c.title }) };
  }
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    webShare: nav?.share ? (data) => nav.share(data) : undefined,
    copy: nav?.clipboard ? (text) => nav.clipboard.writeText(text) : undefined,
  };
}

const styles = StyleSheet.create({
  shell: { flex: 1 },
  screen: { padding: 16, gap: 12 },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: 4,
  },
  tab: {
    flex: 1,
    minHeight: 55,
    paddingVertical: 4,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderTopWidth: 2,
    borderTopColor: 'transparent',
  },
  tabSelected: { backgroundColor: colors.soft, borderTopColor: colors.ink },
  tabIcon: { color: colors.ink, fontSize: 21 },
  tabLabel: {
    textAlign: 'center',
    maxWidth: '100%',
    color: colors.ink,
    fontWeight: '600',
    fontSize: 12,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  menuText: { color: colors.ink, fontSize: 14, flexShrink: 1 },
  dateBar: {
    flexWrap: 'wrap',
    flexDirection: 'row',
    gap: 2,
    alignItems: 'center',
    paddingHorizontal: 2,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  compactButton: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateLabel: {
    color: colors.ink,
    fontWeight: '700',
    fontSize: 14,
    flexShrink: 1,
    minWidth: 50,
    paddingHorizontal: 2,
    textAlign: 'center',
  },
  staffButton: { flexGrow: 1, flexShrink: 1, minWidth: 44, maxWidth: '100%' },

  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  salon: { color: colors.accent, fontWeight: '700', fontSize: 15, flexShrink: 1 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  sectionRow: { justifyContent: 'space-between', marginTop: 8 },
  till: {
    gap: 2,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    backgroundColor: colors.card,
  },
  tillTotal: { fontSize: 16, fontWeight: '700', color: colors.ink },
  tillUnpaid: { fontSize: 14, fontWeight: '600', color: colors.ink },
  section: { marginTop: 8, fontSize: 13, fontWeight: '700', color: colors.muted, letterSpacing: 1 },
  muted: { color: colors.muted, fontSize: 15 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  time: { fontSize: 18, fontWeight: '700', color: colors.ink },
  badge: {
    fontSize: 12,
    color: colors.ink,
    backgroundColor: colors.soft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
  badgeBad: { backgroundColor: '#f6dcd9', color: colors.danger },
  customer: { fontSize: 17, fontWeight: '600', color: colors.ink },
  info: { color: '#2e7d32', fontSize: 15 },
  block: {
    backgroundColor: colors.soft,
    borderRadius: 12,
    padding: 12,
    gap: 4,
    borderLeftWidth: 4,
    borderLeftColor: colors.muted,
  },
  blockTime: { fontSize: 16, fontWeight: '600', color: colors.ink },
});
