'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { VisitProductsByLink } from './VisitProductsByLink';
import { BringingProducts } from './BringingProducts';
import { rememberedLanguages, speakersFirst } from '@/lib/catalogue-languages';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { bookingChannel } from '@/lib/booking-channel';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { addDays, clockToMinutes, formatDay, formatPrice, todayIn, weekdayShort } from '@/lib/time';
import type {
  ClientContact,
  Hold,
  PublicAppointment,
  PublicFreeToday,
  PublicLocation,
  Slot,
} from '@/lib/types';
import { formatRating } from '@/lib/location';
import { CONTACT_ORDER, contactProblems, type ContactField } from '@/lib/contact-check';
import { dialForTimeZone, normalizePhone } from '@/lib/phone';
import { PhoneField } from '../PhoneField';
import { LanguageBadges, SPOKEN, SPOKEN_SHORT, type Spoken } from '../Languages';
import { useSpecialtyText } from '../Specialties';
import { ErrorBox, FieldError, initials, LanguageSwitch, Spinner } from '../ui';
import { ClientNav } from '../client/ClientNav';
import { downloadIcs } from './ics';
import { ShareVisit } from './ShareVisit';
import { SalonGallery } from './SalonGallery';
import { directionsLink, SalonOpenStatus, SalonProfile } from './SalonProfile';
import { SalonReviews } from '../reviews/SalonReviews';
import { NearbySalons } from './NearbySalons';
import { rememberViewed } from '@/lib/recent-salons';
import { FavoriteButton } from './FavoriteButton';
import { InstallBanner } from './InstallBanner';
import { SalonProducts } from './SalonProducts';
import { NO_STORES, type StoreLinks } from '@/lib/install-banner';
import { ShareSalon } from './ShareSalon';
import { VoucherCheck } from './VoucherCheck';
import { WaitlistForm } from './WaitlistForm';
import { asksWishes, WishesPicker } from '../wishes/WishesPicker';
import { WishPhotos } from '../wishes/WishPhotos';
import type { VisitWishes } from '../wishes/wishes';
import { formatLength, priceRows } from './price-rows';

type Step = 'service' | 'staff' | 'time' | 'details' | 'code' | 'done';
/** Key of "any specialist" in the nearest-free-time map. */
const ANY_STAFF = '';

/** The first free slot of each specialist (and of anyone, under ANY_STAFF); slots come in time order. */
function nearestByStaff(slots: Slot[]): Map<string, Slot> {
  const first = new Map<string, Slot>();
  const sorted = [...slots].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const slot of sorted) {
    if (slot.staffIds.length > 0 && !first.has(ANY_STAFF)) first.set(ANY_STAFF, slot);
    for (const id of slot.staffIds) if (!first.has(id)) first.set(id, slot);
  }
  return first;
}
const DAYS_SHOWN = 21;
/** Name, phone and email kept on this device when the client ticks "remember me". */
const REMEMBER_KEY = 'bp_booking_contact';

interface RememberedContact {
  name: string;
  phone: string;
  email: string;
}

function loadRemembered(): RememberedContact | null {
  try {
    const raw = window.localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RememberedContact>;
    if (typeof value.name !== 'string' || typeof value.email !== 'string') return null;
    return {
      name: value.name,
      phone: typeof value.phone === 'string' ? value.phone : '',
      email: value.email,
    };
  } catch {
    return null;
  }
}

/** Task 80: the client's last wishes on this device (the salon remembers them too). */
const WISHES_KEY = 'bp_booking_wishes';
const NO_WISHES: VisitWishes = { mood: null, drink: null, note: null };

function loadWishes(): VisitWishes | null {
  try {
    const raw = window.localStorage.getItem(WISHES_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<VisitWishes>;
    return {
      mood: v.mood === 'chat' || v.mood === 'quiet' || v.mood === 'relax' ? v.mood : null,
      drink:
        v.drink === 'coffee' || v.drink === 'tea' || v.drink === 'water' || v.drink === 'none'
          ? v.drink
          : null,
      note: typeof v.note === 'string' ? v.note.slice(0, 200) : null,
    };
  } catch {
    return null;
  }
}

function saveWishes(value: VisitWishes | null): void {
  try {
    if (value) window.localStorage.setItem(WISHES_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(WISHES_KEY);
  } catch {
    // Blocked storage: nothing is prefilled next time.
  }
}

function saveRemembered(value: RememberedContact | null): void {
  try {
    if (value) window.localStorage.setItem(REMEMBER_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // Private mode or blocked storage: the form simply is not prefilled next time.
  }
}

type Problems = Partial<Record<'name' | 'phone' | 'email' | 'code' | 'terms', string>>;

/**
 * Task Q5: the server's answer about the "Dane" or code fields as errors at those fields; null when
 * it is about something else (then the box on top says it).
 */
function fieldProblems(t: ReturnType<typeof useI18n>['t'], err: unknown): Problems | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'INVALID_CODE') return { code: errorText(t, err) };
  if (err.code === 'PHONE_REQUIRED') return { phone: errorText(t, err) };
  if (err.code !== 'VALIDATION_ERROR' || !Array.isArray(err.details)) return null;
  const texts = {
    name: t.booking.nameInvalid,
    phone: t.booking.phoneInvalid,
    email: t.booking.emailInvalid,
    acceptTerms: t.booking.termsRequired,
  } as const;
  const found: Problems = {};
  for (const detail of err.details as { path?: string }[]) {
    const field = detail.path as keyof typeof texts;
    if (field in texts) found[field === 'acceptTerms' ? 'terms' : field] = texts[field];
  }
  return Object.keys(found).length > 0 ? found : null;
}

/** Task 688: where the cursor goes for an error found before sending ("Dane" step). */
const DETAILS_FIELD: Record<ContactField, string> = {
  name: '#booking-name',
  phone: 'input[type="tel"]',
  email: 'input[type="email"]',
  terms: '#booking-terms',
};

export function BookingFlow({
  slug,
  stores = NO_STORES,
}: {
  slug: string;
  /** Task Q2: App Store / Google Play pages of the client app, once published (from `.env`). */
  stores?: StoreLinks;
}) {
  const { t, locale } = useI18n();
  const specialtyText = useSpecialtyText();
  const tag = LOCALE_TAGS[locale];

  const [salon, setSalon] = useState<PublicLocation | null>(null);
  // The salon's country code is suggested for the phone number (launch task L5).
  const dial = dialForTimeZone(salon?.timezone ?? 'Europe/Warsaw');
  const [closed, setClosed] = useState(false);
  const [step, setStep] = useState<Step>('service');
  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState<string | undefined>(undefined);
  /**
   * Task 70b: "Umów" on a price row of several specialists — "any of these" (or one of them,
   * picked in the circles over the calendar). Empty when the client went through the staff step.
   */
  const [rowStaff, setRowStaff] = useState<string[]>([]);
  /** The client came from the price list straight to the times: "Back" returns there. */
  const [fromList, setFromList] = useState(false);
  /** Task 81: "Speaks EN" — only specialists who speak the chosen language (task 192: any of several). */
  const [speaks, setSpeaks] = useState<Spoken[]>([]);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [day, setDay] = useState('');
  const [hold, setHold] = useState<Hold | null>(null);
  const [contact, setContact] = useState({
    name: '',
    phone: '+48 ',
    email: '',
    acceptTerms: false,
    marketingConsent: false,
  });
  const [codeChannel, setCodeChannel] = useState<'email' | 'sms'>('email');
  // Shown in a window on the salon's own site (public/embed.js): another site's frame cannot
  // keep the client's details or the "My visits" sign-in, and links open in a new tab.
  const [embed, setEmbed] = useState(false);
  /**
   * Task Q2: where the client came from, sent with the hold so the salon sees "Skąd przyszli":
   * the utm_source of the link (the QR code's "qr", "instagram"…), "embed" in a window on the
   * salon's own site, "catalogue" from our own pages, "web" otherwise. With the QR code of a
   * specialist (?utm_source=qr&staff=…) also whose code it was.
   */
  const [channel, setChannel] = useState<{ channel: string; channelStaffId?: string }>();
  /** Task Q2: the specialist whose QR code the client scanned — their times right after the service. */
  const [qrStaff, setQrStaff] = useState<PublicLocation['staff'][number] | null>(null);
  /** Task Q3 (screen C): "Umów kolejną wizytę" after a visit — products to put aside (?product=…). */
  const [bring, setBring] = useState<string[]>([]);
  const [remember, setRemember] = useState(false);
  /** Task 180d: the client is already signed in to "My visits" on this device. */
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const [remembered, setRemembered] = useState(false);
  const [code, setCode] = useState('');
  const [wishes, setWishes] = useState<VisitWishes>(NO_WISHES);
  const [wishesRemembered, setWishesRemembered] = useState(false);
  const [result, setResult] = useState<{
    appointment: PublicAppointment;
    manageToken: string;
    signedIn: boolean;
  }>();

  // Details remembered on this device after an earlier booking.
  useEffect(() => {
    setChannel(bookingChannel(window.location.search, document.referrer, window.location.origin));
    if (new URLSearchParams(window.location.search).get('embed') === '1') {
      setEmbed(true);
      return;
    }
    const lastWishes = loadWishes();
    if (lastWishes && (lastWishes.mood || lastWishes.drink || lastWishes.note)) {
      setWishes(lastWishes);
      setWishesRemembered(true);
    }
    const saved = loadRemembered();
    if (saved) {
      setContact((c) => ({ ...c, ...saved, phone: saved.phone || c.phone }));
      setRemember(true);
      setRemembered(true);
    }
    // Task 180d: a signed-in client finds the form filled in from their latest salon card.
    let live = true;
    api<ClientContact>('/v1/client/me/contact', { auth: false })
      .then((me) => {
        if (!live) return;
        setSignedInAs(me.email);
        setContact((c) => ({
          ...c,
          email: me.email,
          name: me.name ?? c.name,
          phone: me.phone ?? c.phone,
        }));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  function forgetMe() {
    // "Not me" on a device where someone else is signed in to "My visits": sign them out too.
    if (signedInAs) {
      void api('/v1/client/auth/logout', { method: 'POST', auth: false }).catch(() => undefined);
      setSignedInAs(null);
    }
    saveRemembered(null);
    saveWishes(null);
    setWishes(NO_WISHES);
    setWishesRemembered(false);
    setRemember(false);
    setRemembered(false);
    setContact((c) => ({ ...c, name: '', phone: `+${dial} `, email: '' }));
  }
  const [error, setError] = useState('');
  /** Task Q5: errors shown at their own field (name, phone, e-mail, code), not in the box on top. */
  const [problems, setProblems] = useState<Problems>({});
  /**
   * Task 771 (owner's rule: errors where the action is): a refusal that is not about one field (no
   * connection, too many tries, …) is said under the button that was pressed — "Wyślij kod" /
   * "Potwierdź wizytę" on the details step, "Potwierdź wizytę" or "Wyślij kod ponownie" on the code
   * step — not as a box above the form. The box stays for what sends the client back to the times.
   */
  const [actionError, setActionError] = useState<{
    on: 'details' | 'confirm' | 'resend';
    text: string;
  } | null>(null);
  useEffect(() => setActionError(null), [step]);
  /**
   * Task Q9: the salon asks this client to pay the missed visits in the salon with this one
   * (BOOKING_PAY_FIRST): the time stays held and "Potwierdź" books after the notice. `sum` only
   * when the server tells it (a code by email). Bound to the hold it was shown for.
   */
  const [payNotice, setPayNotice] = useState<{ holdId: string; sum: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PublicLocation>(`/v1/public/locations/${slug}`, { auth: false })
      .then((loaded) => {
        // Task 160c: specialists speaking a language chosen in the catalogue come first.
        setSalon({ ...loaded, staff: speakersFirst(loaded.staff, rememberedLanguages()) });
        // Task 403: "Ostatnio oglądane" on the home page — not from a window on the salon's site.
        if (new URLSearchParams(window.location.search).get('embed') !== '1') {
          rememberViewed({ slug: loaded.slug, name: loaded.name });
        }
        const own = dialForTimeZone(loaded.timezone);
        setContact((c) => (c.phone.trim() === '+48' ? { ...c, phone: `+${own} ` } : c));
        // "Book again" from the client app: ?service=…&staff=… skips straight to the times.
        const params = new URLSearchParams(window.location.search);
        const products = (params.get('product') ?? '').split(',').filter(Boolean).slice(0, 10);
        if (products.length) setBring(products);
        const preService = loaded.services.find((s) => s.id === params.get('service'));
        if (!preService) {
          // Task Q2: the QR code of one specialist (?staff=… alone) — the client books with them.
          const qr = loaded.staff.find((s) => s.id === params.get('staff'));
          if (qr) setQrStaff(qr);
          return;
        }
        setServiceId(preService.id);
        const preStaff = loaded.staff.find(
          (s) => s.id === params.get('staff') && s.serviceIds.includes(preService.id),
        );
        setStaffId(preStaff?.id);
        setStep(preStaff ? 'time' : 'staff');
      })
      .catch(() => setClosed(true));
  }, [slug]);

  const service = salon?.services.find((s) => s.id === serviceId);
  const tz = salon?.timezone ?? 'Europe/Warsaw';

  // Task 12: the nearest free time of every specialist on the "who" step ("Today from 14:30").
  const [nearest, setNearest] = useState<Map<string, Slot> | null>(null);
  useEffect(() => {
    if (step !== 'staff' || !serviceId) return;
    let live = true;
    setNearest(null);
    const from = todayIn(tz);
    api<{ slots: Slot[] }>(`/v1/public/locations/${slug}/availability`, {
      auth: false,
      query: { serviceId, from, to: addDays(from, DAYS_SHOWN - 1) },
    })
      .then((res) => {
        if (live) setNearest(nearestByStaff(res.slots));
      })
      // Only a hint: without it the specialists are still there to pick.
      .catch(() => {
        if (live) setNearest(new Map());
      });
    return () => {
      live = false;
    };
  }, [step, serviceId, slug, tz]);

  function nearestText(slot: Slot | undefined): string {
    if (!slot) return t.booking.nearestNone;
    const today = todayIn(tz);
    if (slot.date === today) return fill(t.booking.nearestToday, { time: slot.time });
    if (slot.date === addDays(today, 1))
      return fill(t.booking.nearestTomorrow, { time: slot.time });
    return fill(t.booking.nearestOn, {
      day: formatDay(slot.date, tag, { short: true }),
      time: slot.time,
    });
  }

  function nearestFree(id: string): ReactNode {
    if (nearest === null) return null;
    const slot = nearest.get(id);
    return (
      <span
        className="c-free"
        data-state={slot ? (slot.date === todayIn(tz) ? 'today' : 'later') : 'none'}
      >
        {nearestText(slot)}
      </span>
    );
  }

  const loadSlots = useCallback(async () => {
    if (!serviceId) return;
    setSlots(null);
    const from = todayIn(tz);
    const res = await api<{ slots: Slot[] }>(`/v1/public/locations/${slug}/availability`, {
      auth: false,
      query: {
        serviceId,
        staffId,
        ...(!staffId && rowStaff.length > 1 ? { staffIds: rowStaff.join(',') } : {}),
        from,
        to: addDays(from, DAYS_SHOWN - 1),
      },
    });
    setSlots(res.slots);
    setDay((current) =>
      current && res.slots.some((s) => s.date === current) ? current : (res.slots[0]?.date ?? ''),
    );
  }, [serviceId, staffId, rowStaff, slug, tz]);

  useEffect(() => {
    if (step === 'time') void loadSlots().catch((err) => setError(errorText(t, err)));
  }, [step, loadSlots, t]);

  const days = useMemo(() => {
    const from = todayIn(tz);
    return Array.from({ length: DAYS_SHOWN }, (_, i) => addDays(from, i));
  }, [tz]);

  async function pickTime(slot: Slot) {
    setBusy(true);
    setError('');
    try {
      const created = await api<Hold>(`/v1/public/locations/${slug}/holds`, {
        method: 'POST',
        auth: false,
        idempotencyKey: newIdempotencyKey(),
        body: {
          serviceId,
          staffId,
          ...(!staffId && rowStaff.length > 1 ? { staffIds: rowStaff } : {}),
          start: slot.start,
          ...(hold ? { releaseHoldToken: hold.holdToken } : {}),
          ...channel,
        },
      });
      setHold(created);
      setStep('details');
    } catch (err) {
      setError(errorText(t, err));
      if (err instanceof ApiError && err.code === 'SLOT_TAKEN') await loadSlots();
    } finally {
      setBusy(false);
    }
  }

  function backToTime(err: unknown) {
    setError(errorText(t, err));
    setHold(null);
    setStep('time');
  }

  /**
   * Task 688 (owner's rule: errors at the field): the "Dane" form has no browser checks (they showed
   * a bubble), so an empty or wrong name, phone, e-mail or the unticked terms are said under their
   * field before anything is sent; the cursor goes to the first one. True when all is fine.
   */
  function detailsReady(form: HTMLFormElement | null): boolean {
    const found = contactProblems(
      {
        name: contact.name,
        phone: normalizePhone(contact.phone, dial),
        // A signed-in client's address is their session's: not typed, not checked here.
        email: signedInAs ? undefined : contact.email,
        acceptTerms: contact.acceptTerms,
      },
      {
        name: t.booking.nameInvalid,
        phone: t.booking.phoneInvalid,
        email: t.booking.emailInvalid,
        terms: t.booking.termsRequired,
      },
    );
    const first = CONTACT_ORDER.find((field) => found[field]);
    if (!first) return true;
    setError('');
    setProblems(found);
    form?.querySelector<HTMLInputElement>(DETAILS_FIELD[first])?.focus();
    return false;
  }

  async function sendCode(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    if (!hold) return;
    if (step === 'details' && !detailsReady(e?.currentTarget ?? null)) return;
    setBusy(true);
    setError('');
    setActionError(null);
    setProblems({});
    try {
      const sent = await api<{ channel: 'email' | 'sms' }>(`/v1/public/holds/${hold.holdId}/code`, {
        method: 'POST',
        auth: false,
        body: {
          holdToken: hold.holdToken,
          name: contact.name,
          phone: normalizePhone(contact.phone, dial),
          email: contact.email,
          locale,
          acceptTerms: contact.acceptTerms,
          marketingConsent: contact.marketingConsent,
          codeChannel,
        },
      });
      // The server may send the code by email instead (an address the salon already knows).
      if (sent.channel === 'email' || sent.channel === 'sms') setCodeChannel(sent.channel);
      setStep('code');
    } catch (err) {
      if (err instanceof ApiError && ['HOLD_EXPIRED', 'NOT_FOUND'].includes(err.code)) {
        backToTime(err);
      } else if (err instanceof ApiError && err.code === 'SMS_UNAVAILABLE') {
        setCodeChannel('email');
        setError(errorText(t, err));
      } else {
        // On the code step ("Wyślij kod ponownie") the fields are not on screen: under that button.
        const found = step === 'details' ? fieldProblems(t, err) : null;
        if (found) setProblems(found);
        else
          setActionError({
            on: step === 'details' ? 'details' : 'resend',
            text: errorText(t, err),
          });
      }
    } finally {
      setBusy(false);
    }
  }

  /** Task Q9: BOOKING_PAY_FIRST shows the notice instead of an error; true when it did. */
  function showPayNotice(err: unknown, holdId: string): boolean {
    if (!(err instanceof ApiError) || err.code !== 'BOOKING_PAY_FIRST') return false;
    const details = Array.isArray(err.details)
      ? (err.details as { path?: string; message?: string }[])
      : [];
    const amount = Number(details.find((d) => d.path === 'amountGrosze')?.message);
    const currency = details.find((d) => d.path === 'currency')?.message;
    setPayNotice({
      holdId,
      sum: amount > 0 && currency ? formatPrice(amount, currency, tag) : null,
    });
    return true;
  }

  /** Task 180e: signed in to "My visits" - the session proved the email, no code is needed. */
  async function confirmSignedIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!hold) return;
    if (!detailsReady(e.currentTarget)) return;
    setBusy(true);
    setError('');
    setActionError(null);
    setProblems({});
    const payNoticeAccepted = payNotice?.holdId === hold.holdId;
    try {
      const done = await api<{
        appointment: PublicAppointment;
        manageToken: string;
        signedIn: boolean;
      }>(`/v1/client/holds/${hold.holdId}/confirm`, {
        method: 'POST',
        auth: false,
        idempotencyKey: `confirm-signed-in-${hold.holdId}${payNoticeAccepted ? '-pay' : ''}`,
        body: {
          holdToken: hold.holdToken,
          name: contact.name,
          phone: normalizePhone(contact.phone, dial),
          locale,
          acceptTerms: contact.acceptTerms,
          marketingConsent: contact.marketingConsent,
          ...(asksWishes(salon?.wishQuestions) ? { wishes } : {}),
          ...(payNoticeAccepted ? { payNoticeAccepted } : {}),
        },
      });
      if (asksWishes(salon?.wishQuestions)) saveWishes(remember ? wishes : null);
      saveRemembered(
        remember
          ? { name: contact.name, phone: normalizePhone(contact.phone, dial), email: contact.email }
          : null,
      );
      setResult(done);
      setStep('done');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // The session ended meanwhile: the usual code step.
        setSignedInAs(null);
        setError(errorText(t, err));
      } else if (err instanceof ApiError && ['HOLD_EXPIRED', 'NOT_FOUND'].includes(err.code)) {
        backToTime(err);
      } else if (!showPayNotice(err, hold.holdId)) {
        const found = fieldProblems(t, err);
        if (found) setProblems(found);
        else setActionError({ on: 'details', text: errorText(t, err) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!hold) return;
    // Task 702: fewer than 6 digits — said under the code (the button was silently switched off).
    if (code.length !== 6) {
      setError('');
      setProblems({ code: t.booking.codeIncomplete });
      document.getElementById('booking-code')?.focus();
      return;
    }
    setBusy(true);
    setError('');
    setActionError(null);
    setProblems({});
    const payNoticeAccepted = payNotice?.holdId === hold.holdId;
    try {
      const done = await api<{
        appointment: PublicAppointment;
        manageToken: string;
        signedIn: boolean;
      }>(`/v1/public/holds/${hold.holdId}/confirm`, {
        method: 'POST',
        auth: false,
        idempotencyKey: `confirm-${hold.holdId}-${code}${payNoticeAccepted ? '-pay' : ''}`,
        // Task 180d: the email code signs the client in to "My visits" on this device — the
        // account makes itself on the first booking. Not in a window on another site (embed).
        body: {
          holdToken: hold.holdToken,
          code,
          signIn: !embed,
          ...(asksWishes(salon?.wishQuestions) ? { wishes } : {}),
          ...(payNoticeAccepted ? { payNoticeAccepted } : {}),
        },
      });
      if (!embed) {
        if (asksWishes(salon?.wishQuestions)) saveWishes(remember ? wishes : null);
        saveRemembered(
          remember
            ? {
                name: contact.name,
                phone: normalizePhone(contact.phone, dial),
                email: contact.email,
              }
            : null,
        );
      }
      setResult(done);
      setStep('done');
    } catch (err) {
      if (
        err instanceof ApiError &&
        ['HOLD_EXPIRED', 'TOO_MANY_ATTEMPTS', 'TOO_MANY_CODES'].includes(err.code)
      ) {
        backToTime(err);
      } else if (!showPayNotice(err, hold.holdId)) {
        const found = fieldProblems(t, err);
        if (found) setProblems(found);
        else setActionError({ on: 'confirm', text: errorText(t, err) });
      }
    } finally {
      setBusy(false);
    }
  }

  /** Task Q5: typing in a field takes its error away. */
  const fixed = (field: keyof Problems) => {
    setActionError(null);
    setProblems((current) => {
      if (!current[field]) return current;
      const { [field]: _gone, ...rest } = current;
      return rest;
    });
  };

  if (closed) {
    return (
      <div className="narrow">
        <p className="note">{t.booking.salonClosed}</p>
      </div>
    );
  }
  if (!salon) return <Spinner />;

  const stepIndex = { service: 0, staff: 1, time: 2, details: 3, code: 3, done: 4 }[step];
  const payNoticeShown = !!hold && payNotice?.holdId === hold.holdId;
  const payNoticeBox =
    payNoticeShown && payNotice ? (
      <div className="note stack" style={{ gap: 4 }} role="alert" data-testid="pay-notice">
        <strong>{t.booking.payNoticeTitle}</strong>
        <span className="small">
          {payNotice.sum
            ? fill(t.booking.payNoticeSum, { sum: payNotice.sum })
            : t.booking.payNotice}
        </span>
      </div>
    ) : null;
  const confirmLabel = payNoticeShown ? t.booking.payNoticeConfirm : t.booking.confirm;
  const wishQuestions = asksWishes(salon.wishQuestions) ? salon.wishQuestions : null;
  const stepNames = [
    t.booking.stepService,
    t.booking.stepStaff,
    t.booking.stepTime,
    t.booking.stepDetails,
  ];
  const newTab = embed ? { target: '_blank', rel: 'noopener' } : {};
  const staffOfService = salon.staff.filter((s) => s.serviceIds.includes(serviceId));
  // Languages worth filtering by: spoken by some, not by all, specialists of this service.
  const filterLanguages = SPOKEN.filter((code) => {
    const n = staffOfService.filter((s) => (s.languages ?? []).includes(code)).length;
    return n > 0 && n < staffOfService.length;
  });
  const activeSpeaks = speaks.filter((code) => filterLanguages.includes(code));
  /** Task 62: each specialist's price, shown when the service's prices differ by specialist. */
  const pricesDiffer = !!service && service.priceFromGrosze < service.priceToGrosze;
  function staffPrice(s: PublicLocation['staff'][number]): ReactNode {
    if (!salon || !service || !pricesDiffer) return null;
    const own = s.prices.find((p) => p.serviceId === service.id)?.priceGrosze;
    return (
      <span className="c-price">
        {formatPrice(own ?? service.priceGrosze, salon.currency, tag)}
      </span>
    );
  }
  const staffForService =
    activeSpeaks.length > 0
      ? staffOfService.filter((s) => speaksAny(s.languages, activeSpeaks))
      : staffOfService;
  const daySlots = (slots ?? []).filter((s) => s.date === day);
  const daysWithSlots = new Set((slots ?? []).map((s) => s.date));
  const groups = [
    { label: t.booking.morning, slots: daySlots.filter((s) => clockToMinutes(s.time) < 12 * 60) },
    {
      label: t.booking.afternoon,
      slots: daySlots.filter((s) => {
        const m = clockToMinutes(s.time);
        return m >= 12 * 60 && m < 17 * 60;
      }),
    },
    { label: t.booking.evening, slots: daySlots.filter((s) => clockToMinutes(s.time) >= 17 * 60) },
  ].filter((g) => g.slots.length > 0);

  /*
   * Task Q5: the optional wishes never stand between the code and "Potwierdź wizytę" — one folded
   * line under the button; they are sent with the visit as before.
   */
  const wishesFold =
    hold && (wishQuestions || service?.wishPhotos) ? (
      <details className="wishes-fold" data-testid="wishes-fold">
        <summary className="link-btn small">{t.wishStep.add}</summary>
        {wishQuestions ? (
          <section className="wishes-step" aria-labelledby="wishes-step-title">
            <h3 id="wishes-step-title">{t.wishStep.title}</h3>
            <p className="muted small">{t.wishStep.lead}</p>
            {wishesRemembered ? <p className="note small">{t.wishStep.remembered}</p> : null}
            <WishesPicker questions={wishQuestions} value={wishes} onChange={setWishes} />
          </section>
        ) : null}
        {service?.wishPhotos ? <WishPhotos hold={hold} /> : null}
      </details>
    ) : null;

  return (
    <div className={embed ? 'booking booking--embed' : 'booking'}>
      {/* In a window on the salon's own site the client stays with this salon. */}
      {embed ? null : <ClientNav />}
      {/* Task Q2: "Install the app" — one small row, closes with one tap; the app continues from here. */}
      {/* Task Q5: only on the first screen — not between the client and the next steps. */}
      {embed || step !== 'service' ? null : (
        <InstallBanner
          place={{
            slug: salon.slug,
            salonName: salon.name,
            serviceId: serviceId || undefined,
            staffId,
          }}
          stores={stores}
        />
      )}
      <header className="salon-head">
        <div className="salon-head-inner">
          <div className="top">
            <span className="small muted">{t.booking.bookVisit}</span>
            <LanguageSwitch query={embed ? '?embed=1' : ''} />
          </div>
          <h1 className="salon-name">{salon.name}</h1>
          <span className="muted small">
            {salon.addressLine}, {salon.postalCode} {salon.city}
          </span>
          <LanguageBadges codes={salon.languages ?? []} label={t.languages.speaks} />
          {/* Task 405: a client signed in to "Moje wizyty" saves the salon to "Ulubione". */}
          {signedInAs && !embed ? <FavoriteButton slug={salon.slug} /> : null}
          {/*
           * Task Q5 (N36): one line "O salonie ▸" with today's status; the map, description,
           * hours, sharing and photos open from it, so the services are seen without scrolling.
           */}
          <details className="salon-more" data-testid="salon-more">
            <summary>
              <span className="salon-more-title">{t.profile.description}</span>
              <SalonOpenStatus salon={salon} />
            </summary>
            <div className="salon-more-body">
              <SalonProfile salon={salon} />
              {/* Task 406: not in a window on the salon's own site. */}
              {embed ? null : <ShareSalon name={salon.name} slug={salon.slug} />}
              <SalonGallery photos={salon.photos ?? []} />
            </div>
          </details>
          <SalonReviews slug={salon.slug} />
        </div>
      </header>

      <main className="narrow stack">
        {step !== 'done' ? (
          <ol className="progress" aria-label={t.booking.bookVisit}>
            {stepNames.map((name, i) => (
              <li
                key={name}
                data-state={i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'next'}
                aria-current={i === stepIndex ? 'step' : undefined}
              >
                {name}
              </li>
            ))}
          </ol>
        ) : null}

        <ErrorBox>{error}</ErrorBox>

        {/* Task Q2: scanned at one specialist's mirror — booking with them, unless the client changes it. */}
        {step === 'service' && qrStaff ? (
          <p className="qr-staff" data-testid="qr-staff">
            <span>{fill(t.booking.qrStaff, { name: qrStaff.displayName })}</span>
            <button type="button" className="link-btn" onClick={() => setQrStaff(null)}>
              {t.booking.qrStaffChange}
            </button>
          </p>
        ) : null}
        {step === 'service' ? (
          <ServiceList
            salon={salon}
            speaks={speaks}
            onSpeaks={setSpeaks}
            onPick={(id, row) => {
              setServiceId(id);
              setError('');
              if (row) {
                // A price row: one specialist → their times; several → "any of these" first.
                setStaffId(row.length === 1 ? row[0] : undefined);
                setRowStaff(row.length > 1 ? row : []);
                setFromList(true);
                setStep('time');
                return;
              }
              setRowStaff([]);
              setFromList(false);
              if (qrStaff && qrStaff.serviceIds.includes(id)) {
                // The specialist's own QR code: straight to their free times.
                setStaffId(qrStaff.id);
                setStep('time');
                return;
              }
              setStaffId(undefined);
              setStep('staff');
            }}
          />
        ) : null}

        {/* Task Q3: "Produkty salonu" — one folded row; nothing when the salon shows no products. */}
        {step === 'service' ? <SalonProducts slug={salon.slug} /> : null}

        {/* Task 537: "Sprawdź bon" — also on the salon's own site. */}
        {step === 'service' ? <VoucherCheck slug={salon.slug} /> : null}

        {/* Task 400: on the salon's own site (embed) the client stays with this salon. */}
        {step === 'service' && !embed ? <NearbySalons slug={salon.slug} /> : null}

        {step === 'staff' && service ? (
          <section className="stack">
            <h2>{service.name}</h2>
            {filterLanguages.length > 0 ? (
              /* Task Q5: folded — most clients book without it; open while a language is chosen. */
              <details className="speaks-fold" open={activeSpeaks.length > 0}>
                <summary className="small">{t.languages.filterLabel}</summary>
                <div className="field">
                  <span id="speaks-filter" className="visually-hidden">
                    {t.languages.filterLabel}
                  </span>
                  <span className="chips" role="group" aria-labelledby="speaks-filter">
                    <button
                      type="button"
                      aria-pressed={activeSpeaks.length === 0}
                      onClick={() => setSpeaks([])}
                    >
                      {t.languages.filterAll}
                    </button>
                    {filterLanguages.map((code) => (
                      <button
                        key={code}
                        type="button"
                        aria-pressed={activeSpeaks.includes(code)}
                        aria-label={`${t.languages.filterLabel}: ${t.languages.names[code]}`}
                        onClick={() => setSpeaks(toggled(activeSpeaks, code))}
                      >
                        <b>{SPOKEN_SHORT[code]}</b> {t.languages.names[code]}
                      </button>
                    ))}
                  </span>
                </div>
              </details>
            ) : null}
            <ul className="choice-list">
              {/* "Any specialist" could pick someone without the language: hidden while filtering. */}
              {activeSpeaks.length > 0 ? null : (
                <li>
                  <button
                    type="button"
                    className="with-avatar"
                    onClick={() => {
                      setStaffId(undefined);
                      setRowStaff([]);
                      setStep('time');
                    }}
                  >
                    <span className="avatar avatar--staff avatar--any" aria-hidden="true">
                      ∗
                    </span>
                    <span className="c-body">
                      <span className="c-name">{t.booking.anyStaff}</span>
                      <span className="c-meta">{t.booking.anyStaffHint}</span>
                      {nearestFree(ANY_STAFF)}
                    </span>
                    {pricesDiffer && service ? (
                      <span className="c-price">
                        {fill(t.booking.priceFrom, {
                          price: formatPrice(service.priceFromGrosze, salon.currency, tag),
                        })}
                      </span>
                    ) : null}
                  </button>
                </li>
              )}
              {staffForService.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="with-avatar"
                    onClick={() => {
                      setStaffId(s.id);
                      setRowStaff([]);
                      setStep('time');
                    }}
                  >
                    <span className="avatar avatar--staff" aria-hidden="true">
                      {s.photoUrl ? (
                        <img src={s.photoUrl} alt="" decoding="async" />
                      ) : (
                        initials(s.displayName)
                      )}
                    </span>
                    <span className="c-body">
                      <span className="c-name">{s.displayName}</span>
                      {specialtyText(s.specialties, s.customSpecialty) ? (
                        <span className="c-specialty">
                          {specialtyText(s.specialties, s.customSpecialty)}
                        </span>
                      ) : null}
                      {s.bio ? <span className="c-meta">{s.bio}</span> : null}
                      {/* Task 384: the specialist's stars, as on the salon cards of the catalogue. */}
                      {formatRating(s, LOCALE_TAGS[locale]) ? (
                        <span className="c-meta staff-rating">
                          {fill(t.directory.rating, {
                            rating: formatRating(s, LOCALE_TAGS[locale])!,
                            n: String(s.reviewCount),
                          })}
                        </span>
                      ) : null}
                      <LanguageBadges codes={s.languages ?? []} />
                      {nearestFree(s.id)}
                    </span>
                    {staffPrice(s)}
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="link-btn small" onClick={() => setStep('service')}>
              {t.common.back}
            </button>
          </section>
        ) : null}

        {step === 'time' && service ? (
          <section className="stack">
            <h2>{service.name}</h2>
            {rowStaff.length > 1 ? (
              // Task 70b: the row's specialists over the calendar, "Dowolny" first (as in Booksy).
              <div className="row-staff" role="group" aria-label={t.booking.stepStaff}>
                <button type="button" aria-pressed={!staffId} onClick={() => setStaffId(undefined)}>
                  <span className="avatar avatar--staff avatar--any" aria-hidden="true">
                    ∗
                  </span>
                  <span>{t.booking.anyShort}</span>
                </button>
                {rowStaff.map((id) => {
                  const s = salon.staff.find((x) => x.id === id);
                  if (!s) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={staffId === id}
                      onClick={() => setStaffId(id)}
                    >
                      <span className="avatar avatar--staff" aria-hidden="true">
                        {s.photoUrl ? (
                          <img src={s.photoUrl} alt="" decoding="async" />
                        ) : (
                          initials(s.displayName)
                        )}
                      </span>
                      <span>{s.displayName}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {slots === null ? (
              <Spinner />
            ) : slots.length === 0 ? (
              <p className="note">{t.booking.noSlotsAtAll}</p>
            ) : (
              <>
                <div className="day-strip" role="group">
                  {days.map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={d === day}
                      // A full day can still be chosen: "tell me when a time frees up" (task 50).
                      className={daysWithSlots.has(d) ? undefined : 'full'}
                      onClick={() => setDay(d)}
                      aria-label={formatDay(d, tag)}
                    >
                      <span>{weekdayShort(d, tag)}</span>
                      <b>{Number(d.slice(8))}</b>
                    </button>
                  ))}
                </div>
                <p className="muted small">{day ? formatDay(day, tag) : ''}</p>
                {groups.length === 0 ? (
                  <>
                    <p className="note">{t.booking.noSlotsDay}</p>
                    {day ? (
                      <WaitlistForm
                        key={`${day}|${staffId ?? ''}`}
                        slug={slug}
                        serviceId={serviceId}
                        staffId={staffId}
                        date={day}
                        name={contact.name}
                        email={contact.email}
                        signedInAs={signedInAs}
                        phone={contact.phone}
                        dial={dial}
                      />
                    ) : null}
                  </>
                ) : (
                  groups.map((g) => (
                    <div key={g.label} className="stack" style={{ gap: 8 }}>
                      <h3 className="muted small">{g.label}</h3>
                      <div className="times">
                        {g.slots.map((s) => (
                          <button
                            key={s.start}
                            type="button"
                            disabled={busy}
                            onClick={() => void pickTime(s)}
                          >
                            {s.time}
                            {s.discountPercent ? (
                              // The salon's happy hours (task 16): at least this much off.
                              <span className="time-deal">−{s.discountPercent}%</span>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </>
            )}
            <button
              type="button"
              className="link-btn small"
              onClick={() => setStep(fromList ? 'service' : 'staff')}
            >
              {t.common.back}
            </button>
          </section>
        ) : null}

        {(step === 'details' || step === 'code') && hold ? (
          <HoldSummary
            hold={hold}
            onExpired={() => backToTime(new ApiError(410, 'HOLD_EXPIRED', ''))}
          >
            <button
              type="button"
              className="link-btn small"
              onClick={() => {
                setStep('time');
              }}
            >
              {t.booking.changeTime}
            </button>
          </HoldSummary>
        ) : null}

        {step === 'details' && hold ? (
          <form
            noValidate
            className="form"
            onSubmit={(e) => void (signedInAs ? confirmSignedIn(e) : sendCode(e))}
          >
            <h2>{t.booking.yourDetails}</h2>
            {/* Audit EJ fix: products chosen on the last visit, named before confirming. */}
            <BringingProducts slug={salon.slug} ids={bring} />
            {signedInAs ? (
              <p className="note small" data-testid="signed-in-as">
                {fill(t.booking.signedInAs, { email: signedInAs })} {t.booking.noCodeNeeded}
              </p>
            ) : null}
            {remembered || signedInAs ? (
              <button type="button" className="link-btn small" onClick={forgetMe}>
                {t.booking.notMe}
              </button>
            ) : null}
            <label className="field">
              <span>{t.booking.name}</span>
              <input
                id="booking-name"
                autoComplete="name"
                required
                aria-invalid={problems.name ? true : undefined}
                aria-describedby={problems.name ? 'name-error' : undefined}
                value={contact.name}
                onChange={(e) => {
                  fixed('name');
                  setContact({ ...contact, name: e.target.value });
                }}
              />
              <FieldError id="name-error" text={problems.name} />
            </label>
            <PhoneField
              label={t.booking.phone}
              required
              value={contact.phone}
              defaultDial={dial}
              error={problems.phone}
              onChange={(phone) => {
                fixed('phone');
                setContact({ ...contact, phone });
              }}
            />
            <label className="field">
              <span>{t.booking.email}</span>
              <input
                type="email"
                autoComplete="email"
                required
                // Task 180e: the email of the session; another one - "To nie ja".
                readOnly={!!signedInAs}
                aria-invalid={problems.email ? true : undefined}
                aria-describedby={problems.email ? 'email-error' : undefined}
                value={contact.email}
                onChange={(e) => {
                  fixed('email');
                  setContact({ ...contact, email: e.target.value });
                }}
              />
              <FieldError id="email-error" text={problems.email} />
              <small className="muted">{t.booking.emailHint}</small>
            </label>
            <label className="check">
              <input
                id="booking-terms"
                type="checkbox"
                required
                checked={contact.acceptTerms}
                aria-invalid={problems.terms ? true : undefined}
                aria-describedby={problems.terms ? 'terms-error' : undefined}
                onChange={(e) => {
                  fixed('terms');
                  setContact({ ...contact, acceptTerms: e.target.checked });
                }}
              />
              <span>
                {t.legal.acceptBefore}
                <a href={`/${locale}/b/${slug}/regulamin`} target="_blank" rel="noopener">
                  {t.legal.acceptTerms}
                </a>
                {t.legal.acceptMiddle}
                <a href={`/${locale}/b/${slug}/privacy`} target="_blank" rel="noopener">
                  {t.legal.acceptPrivacy}
                </a>
                {t.legal.acceptAfter}
                <FieldError id="terms-error" text={problems.terms} />
              </span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={contact.marketingConsent}
                onChange={(e) => setContact({ ...contact, marketingConsent: e.target.checked })}
              />
              <span>{t.booking.marketing}</span>
            </label>
            {embed ? null : (
              <label className="check">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                <span>
                  {t.booking.rememberMe}
                  <small className="muted remember-hint">{t.booking.rememberMeHint}</small>
                </span>
              </label>
            )}
            {!signedInAs && salon.codeChannels?.includes('sms') ? (
              <div className="field">
                <span id="code-via">{t.booking.codeVia}</span>
                <span className="seg seg--wide" role="group" aria-labelledby="code-via">
                  <button
                    type="button"
                    aria-pressed={codeChannel === 'email'}
                    onClick={() => setCodeChannel('email')}
                  >
                    {t.booking.viaEmail}
                  </button>
                  <button
                    type="button"
                    aria-pressed={codeChannel === 'sms'}
                    onClick={() => setCodeChannel('sms')}
                  >
                    {t.booking.viaSms}
                  </button>
                </span>
              </div>
            ) : null}
            {signedInAs ? payNoticeBox : null}
            <button
              className="btn btn--block"
              disabled={busy}
              aria-describedby={actionError?.on === 'details' ? 'details-action-error' : undefined}
            >
              {signedInAs ? confirmLabel : t.booking.sendCode}
            </button>
            <FieldError
              id="details-action-error"
              text={actionError?.on === 'details' ? actionError.text : undefined}
            />
            {signedInAs ? wishesFold : null}
          </form>
        ) : null}

        {step === 'code' && hold ? (
          <form noValidate className="form" onSubmit={confirm}>
            <h2>{codeChannel === 'sms' ? t.booking.codeTitleSms : t.booking.codeTitle}</h2>
            <p className="muted">
              {codeChannel === 'sms'
                ? fill(t.booking.codeLeadSms, { phone: normalizePhone(contact.phone, dial) })
                : fill(t.booking.codeLead, { email: contact.email })}
            </p>
            <input
              id="booking-code"
              className="code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              aria-label={codeChannel === 'sms' ? t.booking.codeTitleSms : t.booking.codeTitle}
              aria-invalid={problems.code ? true : undefined}
              aria-describedby={problems.code ? 'code-error' : undefined}
              value={code}
              onChange={(e) => {
                fixed('code');
                setCode(e.target.value.replace(/\D/g, ''));
              }}
            />
            <FieldError id="code-error" text={problems.code} />
            {payNoticeBox}
            <button
              className="btn btn--block"
              disabled={busy}
              aria-describedby={actionError?.on === 'confirm' ? 'confirm-action-error' : undefined}
            >
              {confirmLabel}
            </button>
            <FieldError
              id="confirm-action-error"
              text={actionError?.on === 'confirm' ? actionError.text : undefined}
            />
            {wishesFold}
            <button
              type="button"
              className="link-btn small"
              disabled={busy}
              aria-describedby={actionError?.on === 'resend' ? 'resend-action-error' : undefined}
              onClick={() => void sendCode()}
            >
              {t.booking.resend}
            </button>
            <FieldError
              id="resend-action-error"
              text={actionError?.on === 'resend' ? actionError.text : undefined}
            />
            {/* Task 608: a mistyped address is fixed here, not by picking the time again. */}
            <button
              type="button"
              className="link-btn small"
              disabled={busy}
              onClick={() => {
                setError('');
                setProblems({});
                setCode('');
                setStep('details');
              }}
            >
              {t.booking.fixContact}
            </button>
          </form>
        ) : null}

        {step === 'done' && result ? (
          <section className="stack">
            <div className="done-mark" aria-hidden="true">
              ✓
            </div>
            {/* Task 161b: the salon's cancellation guard asks it to accept this client's visit. */}
            <h1>
              {result.appointment.awaitingApproval
                ? t.booking.doneTitleApproval
                : t.booking.doneTitle}
            </h1>
            <p>
              {result.appointment.awaitingApproval
                ? t.booking.doneLeadApproval
                : t.booking.doneLead}
            </p>
            <div className="summary">
              <span className="big">
                {result.appointment.time} ·{' '}
                {formatDay(result.appointment.date, tag, { short: true })}
              </span>
              <span>
                {result.appointment.service.name} · {result.appointment.staff.displayName}
              </span>
              <span className="muted small">
                {salon.name}, {salon.addressLine}, {salon.city}
              </span>
            </div>
            {/* Task Q5: one main button; the rest are quiet links. */}
            <button
              type="button"
              className="btn btn--block"
              onClick={() => downloadIcs(result.appointment)}
            >
              {t.booking.addToCalendar}
            </button>
            <div className="done-links">
              <a
                className="link-btn small"
                href={directionsLink(salon)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t.booking.directions}
              </a>
              {/* Task 413: tell someone when and where, right after booking. */}
              <ShareVisit visit={result.appointment} className="link-btn small" />
              <Link
                className="link-btn small"
                href={`/${locale}/m/${result.manageToken}`}
                {...newTab}
              >
                {t.booking.manage}
              </Link>
              {/* Task 417: right after booking, the signed-in client can save the salon. */}
              {result.signedIn && !signedInAs && !embed ? (
                <FavoriteButton slug={salon.slug} className="link-btn small" />
              ) : null}
            </div>
            {/* Task Q3 (screen A): folded and optional — products picked up at the visit. */}
            {embed ? null : (
              <VisitProductsByLink
                endpoint={`/v1/public/appointments/${result.manageToken}`}
                offer
                bring={bring}
              />
            )}
            {result.signedIn ? (
              <section className="account-ready small" data-testid="account-ready">
                <p>
                  {t.booking.accountReady}{' '}
                  <Link className="link-btn" href={`/${locale}/c`}>
                    {t.visits.allVisits}
                  </Link>
                </p>
                <p className="muted">
                  {t.booking.appTitle}
                  {' · '}
                  <Link className="link-btn" href={`/${locale}/c`}>
                    {t.booking.installApp}
                  </Link>
                </p>
              </section>
            ) : (
              <Link className="link-btn small" href={`/${locale}/c`} {...newTab}>
                {t.visits.allVisits}
              </Link>
            )}
          </section>
        ) : null}
      </main>
    </div>
  );
}

/** Task 192: a specialist speaking any of the chosen languages. */
function speaksAny(languages: Spoken[] | undefined, chosen: Spoken[]): boolean {
  return (languages ?? []).some((code) => chosen.includes(code));
}

/** Task 192: the chip adds its language to the choice, or takes it away. */
function toggled(chosen: Spoken[], code: Spoken): Spoken[] {
  return chosen.includes(code) ? chosen.filter((c) => c !== code) : [...chosen, code];
}

function ServiceList({
  salon,
  speaks,
  onSpeaks,
  onPick,
}: {
  salon: PublicLocation;
  speaks: Spoken[];
  onSpeaks: (codes: Spoken[]) => void;
  /** Without a row: the specialist step; with one: straight to the times of these specialists. */
  onPick: (serviceId: string, row?: string[]) => void;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  // Task 120: "Wolne dziś" — who can still be booked today (any of their services).
  const [freeToday, setFreeToday] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    api<PublicFreeToday>(`/v1/public/locations/${salon.slug}/free-today`, { auth: false })
      .then((res) => {
        if (live) setFreeToday(new Set(res.staffIds));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [salon.slug]);
  const freeNames = salon.staff.filter((s) => freeToday.has(s.id)).map((s) => s.displayName);
  // Task 81 on the price list: languages spoken by some, not all, of the salon's specialists.
  const filterLanguages = SPOKEN.filter((code) => {
    const n = salon.staff.filter((s) => (s.languages ?? []).includes(code)).length;
    return n > 0 && n < salon.staff.length;
  });
  const active = speaks.filter((code) => filterLanguages.includes(code));
  const team =
    active.length > 0 ? salon.staff.filter((s) => speaksAny(s.languages, active)) : salon.staff;
  const length = (minutes: number) => formatLength(minutes, t.booking.hoursShort, t.common.minutes);

  const groups = [
    ...salon.categories.map((c) => ({
      id: c.id,
      name: c.name,
      services: salon.services.filter((s) => s.categoryId === c.id),
    })),
    {
      id: 'none',
      name: salon.categories.length ? t.booking.otherServices : '',
      services: salon.services.filter((s) => !s.categoryId),
    },
  ]
    .map((g) => ({
      ...g,
      services: g.services
        .map((service) => {
          const doing = salon.staff.filter((x) => x.serviceIds.includes(service.id));
          return { service, doing, rows: priceRows(service, team) };
        })
        // While filtering by language, a service nobody speaking it does is hidden.
        .filter((x) => active.length === 0 || x.rows.length > 0),
    }))
    .filter((g) => g.services.length > 0);

  return (
    <section className="stack">
      {freeNames.length > 0 ? (
        <p className="free-today small" role="status">
          <span className="free-dot" aria-hidden="true" />
          {fill(t.booking.freeToday, { names: freeNames.join(', ') })}
        </p>
      ) : null}
      {filterLanguages.length > 0 ? (
        /* Task Q5: folded — most clients book without it; open while a language is chosen. */
        <details className="speaks-fold" open={active.length > 0}>
          <summary className="small">{t.languages.filterLabel}</summary>
          <div className="field">
            <span id="speaks-list-filter" className="visually-hidden">
              {t.languages.filterLabel}
            </span>
            <span className="chips" role="group" aria-labelledby="speaks-list-filter">
              <button type="button" aria-pressed={active.length === 0} onClick={() => onSpeaks([])}>
                {t.languages.filterAll}
              </button>
              {filterLanguages.map((code) => (
                <button
                  key={code}
                  type="button"
                  aria-pressed={active.includes(code)}
                  aria-label={`${t.languages.filterLabel}: ${t.languages.names[code]}`}
                  onClick={() => onSpeaks(toggled(active, code))}
                >
                  <b>{SPOKEN_SHORT[code]}</b> {t.languages.names[code]}
                </button>
              ))}
            </span>
          </div>
        </details>
      ) : null}
      {groups.map((g) => (
        <div key={g.id}>
          {g.name ? <h3 className="group-title">{g.name}</h3> : null}
          <ul className="service-cards">
            {g.services.map(({ service: s, doing, rows }) => {
              // Everyone doing the service at one price: one "All specialists" row.
              const allOneRow =
                active.length === 0 &&
                rows.length === 1 &&
                doing.length > 1 &&
                rows[0]?.staff.length === doing.length;
              return (
                <li key={s.id} className="service-card">
                  <ul className="choice-list">
                    <li>
                      <button type="button" onClick={() => onPick(s.id)}>
                        <span className="c-name">{s.name}</span>
                        <span className="c-meta">
                          {s.durationMinutes} {t.common.minutes}
                          {s.description ? ` · ${s.description}` : ''}
                        </span>
                        <span className="c-price">
                          {s.priceFromGrosze < s.priceToGrosze
                            ? fill(t.booking.priceFrom, {
                                price: formatPrice(s.priceFromGrosze, salon.currency, tag),
                              })
                            : formatPrice(s.priceFromGrosze, salon.currency, tag)}
                        </span>
                      </button>
                    </li>
                  </ul>
                  {rows.length > 0 ? (
                    <>
                      <div className="service-team">
                        {rows
                          .flatMap((r) => r.staff)
                          .map((x) => (
                            <button
                              key={x.id}
                              type="button"
                              className="avatar avatar--staff"
                              data-free-today={freeToday.has(x.id) || undefined}
                              title={x.displayName}
                              aria-label={fill(t.booking.staffTimes, { name: x.displayName })}
                              onClick={() => onPick(s.id, [x.id])}
                            >
                              {x.photoUrl ? (
                                <img src={x.photoUrl} alt="" decoding="async" />
                              ) : (
                                initials(x.displayName)
                              )}
                            </button>
                          ))}
                      </div>
                      <ul className="price-rows">
                        {rows.map((r) => {
                          const names = r.staff.map((x) => x.displayName).join(', ');
                          return (
                            <li key={`${r.priceGrosze}|${r.durationMinutes}`}>
                              <span className="pr-who">
                                {allOneRow
                                  ? t.booking.allStaff
                                  : r.staff.map((x, i) => (
                                      <span key={x.id} className="pr-name">
                                        {x.displayName}
                                        {/* Only languages not everyone speaks: the ones worth choosing by. */}
                                        <LanguageBadges
                                          codes={(x.languages ?? []).filter((c) =>
                                            filterLanguages.includes(c),
                                          )}
                                        />
                                        {i < r.staff.length - 1 ? ', ' : ''}
                                      </span>
                                    ))}
                              </span>
                              <span className="pr-offer">
                                {formatPrice(r.priceGrosze, salon.currency, tag)} ·{' '}
                                {length(r.durationMinutes)}
                              </span>
                              <button
                                type="button"
                                className="btn btn--small"
                                aria-label={fill(t.booking.bookRowLabel, {
                                  names: allOneRow ? t.booking.allStaff : names,
                                })}
                                onClick={() =>
                                  onPick(
                                    s.id,
                                    r.staff.map((x) => x.id),
                                  )
                                }
                              >
                                {t.booking.bookRow}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** The held time with a countdown; when it runs out the client picks a time again. */
function HoldSummary({
  hold,
  onExpired,
  children,
}: {
  hold: Hold;
  onExpired: () => void;
  children?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [left, setLeft] = useState(() => Date.parse(hold.expiresAt) - Date.now());
  const expired = useRef(onExpired);
  expired.current = onExpired;
  useEffect(() => {
    const timer = window.setInterval(() => {
      const ms = Date.parse(hold.expiresAt) - Date.now();
      setLeft(ms);
      if (ms <= 0) {
        window.clearInterval(timer);
        expired.current();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hold.expiresAt]);
  const seconds = Math.max(0, Math.floor(left / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <div className="summary">
      <span className="big">
        {hold.time} · {formatDay(hold.date, tag, { short: true })}
      </span>
      <span>
        {hold.serviceName} · {hold.staffName} ·{' '}
        {hold.listPriceGrosze !== null ? (
          <>
            <s className="muted">{formatPrice(hold.listPriceGrosze, hold.currency, tag)}</s>{' '}
          </>
        ) : null}
        {formatPrice(hold.priceGrosze, hold.currency, tag)}
        {hold.happyHourPercent ? (
          <span className="time-deal">−{hold.happyHourPercent}%</span>
        ) : null}
      </span>
      <span className="small muted timer" aria-live="polite">
        {fill(t.booking.heldFor, { time: clock })}
      </span>
      {children}
    </div>
  );
}
