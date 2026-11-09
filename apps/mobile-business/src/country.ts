import type { Currency } from '@beauty/api-client';
import type { Locale } from './api';

/**
 * "Kraj i strefa czasowa" and "Waluta cen" in the business app (task 323; in the cabinet —
 * "Ustawienia", launch task L5): the same lists as the cabinet and the server. No React Native
 * here — tested in Vitest (test/country.test.ts). Country and currency names come from Intl when
 * the phone has it; without it the zone's city and the currency's code are shown.
 */

/** The country of a time zone. Europe/Kiev is the name the server (ICU) knows for Kyiv. */
const REGION_BY_TIME_ZONE: Record<string, string> = {
  'Europe/Warsaw': 'PL',
  'Europe/Kiev': 'UA',
  'Europe/Minsk': 'BY',
  'Europe/Vilnius': 'LT',
  'Europe/Riga': 'LV',
  'Europe/Tallinn': 'EE',
  'Europe/Berlin': 'DE',
  'Europe/Prague': 'CZ',
  'Europe/Bratislava': 'SK',
  'Europe/Vienna': 'AT',
  'Europe/Budapest': 'HU',
  'Europe/Bucharest': 'RO',
  'Europe/Sofia': 'BG',
  'Europe/Athens': 'GR',
  'Asia/Nicosia': 'CY',
  'Europe/Rome': 'IT',
  'Europe/Malta': 'MT',
  'Europe/Madrid': 'ES',
  'Europe/Lisbon': 'PT',
  'Europe/Paris': 'FR',
  'Europe/Brussels': 'BE',
  'Europe/Amsterdam': 'NL',
  'Europe/Luxembourg': 'LU',
  'Europe/Dublin': 'IE',
  'Europe/Copenhagen': 'DK',
  'Europe/Stockholm': 'SE',
  'Europe/Helsinki': 'FI',
  'Europe/Ljubljana': 'SI',
  'Europe/Zagreb': 'HR',
  'Europe/London': 'GB',
  'Europe/Oslo': 'NO',
  'Europe/Zurich': 'CH',
  'Europe/Tirane': 'AL',
  'Europe/Istanbul': 'TR',
  'Europe/Skopje': 'MK',
  'Europe/Belgrade': 'RS',
  'Europe/Podgorica': 'ME',
  'Europe/Sarajevo': 'BA',
  'Europe/Chisinau': 'MD',
  'Asia/Tbilisi': 'GE',
  'Asia/Yerevan': 'AM',
  'Asia/Baku': 'AZ',
  'Asia/Almaty': 'KZ',
  'Asia/Qostanay': 'KZ',
  'Asia/Aqtobe': 'KZ',
  'Asia/Bishkek': 'KG',
  'Asia/Tashkent': 'UZ',
  'Asia/Samarkand': 'UZ',
  'Asia/Dushanbe': 'TJ',
  'Asia/Ashgabat': 'TM',
  'Europe/Moscow': 'RU',
};

/** The currencies the server accepts, in the cabinet's order. */
export const CURRENCIES = [
  'PLN',
  'EUR',
  'CZK',
  'HUF',
  'RON',
  'SEK',
  'DKK',
  'NOK',
  'CHF',
  'GBP',
  'ALL',
  'TRY',
  'MKD',
  'RSD',
  'BAM',
  'MDL',
  'UAH',
  'GEL',
  'AMD',
  'AZN',
  'KZT',
  'KGS',
  'UZS',
  'TJS',
  'TMT',
  'BYN',
  'RUB',
] as const satisfies readonly Currency[];

const INTL_LOCALE: Record<Locale, string> = { pl: 'pl-PL', uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' };

/** Intl.DisplayNames when the phone's JavaScript has it (Hermes may not), otherwise null. */
function displayName(locale: Locale, type: 'region' | 'currency', code: string): string | null {
  try {
    if (typeof Intl.DisplayNames !== 'function') return null;
    const name = new Intl.DisplayNames([INTL_LOCALE[locale]], { type }).of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/** "Turcja (Istanbul)": the country in the reader's language and the zone's city. */
export function timeZoneLabel(timeZone: string, locale: Locale): string {
  const region = REGION_BY_TIME_ZONE[timeZone === 'Europe/Kyiv' ? 'Europe/Kiev' : timeZone];
  const city = (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
  const shownCity = city === 'Kiev' ? 'Kyiv' : city;
  if (!region) return timeZone;
  return `${displayName(locale, 'region', region) ?? region} (${shownCity})`;
}

/**
 * Time zones a salon can choose: one per country (Kazakhstan and Uzbekistan have more). Poland
 * first, then by country name in the reader's language. A zone saved before this list existed
 * stays in it, so the salon's own zone is always shown.
 */
export function salonTimeZones(
  locale: Locale,
  current?: string,
): { timeZone: string; label: string }[] {
  const zones = Object.keys(REGION_BY_TIME_ZONE);
  if (current && !zones.includes(current)) zones.push(current);
  return zones
    .map((timeZone) => ({ timeZone, label: timeZoneLabel(timeZone, locale) }))
    .sort((a, b) =>
      a.timeZone === 'Europe/Warsaw'
        ? -1
        : b.timeZone === 'Europe/Warsaw'
          ? 1
          : a.label.localeCompare(b.label, INTL_LOCALE[locale]),
    );
}

/** "EUR — euro", or just "EUR" when the phone cannot name it. */
export function currencyName(currency: string, locale: Locale): string {
  const name = displayName(locale, 'currency', currency);
  return name ? `${currency} — ${name}` : currency;
}

/** Zones or currencies whose name contains what the person typed (case and accents ignored). */
export function matching<T extends { label: string }>(items: T[], typed: string): T[] {
  const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const query = plain(typed.trim());
  return query ? items.filter((item) => plain(item.label).includes(query)) : items;
}

const CURRENCY_BY_REGION: Record<string, Currency> = {
  PL: 'PLN',
  CZ: 'CZK',
  HU: 'HUF',
  RO: 'RON',
  SE: 'SEK',
  DK: 'DKK',
  NO: 'NOK',
  CH: 'CHF',
  GB: 'GBP',
  AL: 'ALL',
  TR: 'TRY',
  MK: 'MKD',
  RS: 'RSD',
  BA: 'BAM',
  MD: 'MDL',
  UA: 'UAH',
  GE: 'GEL',
  AM: 'AMD',
  AZ: 'AZN',
  KZ: 'KZT',
  KG: 'KGS',
  UZ: 'UZS',
  TJ: 'TJS',
  TM: 'TMT',
  BY: 'BYN',
  RU: 'RUB',
};

/**
 * Task 350 ("Załóż salon"): the zone of the phone when it is one of the salon zones (Kyiv under
 * either name), otherwise Warsaw — as the cabinet's sign-up does with the browser's zone.
 */
export function salonZoneOf(phoneZone: string | undefined): string {
  const zone = phoneZone === 'Europe/Kyiv' ? 'Europe/Kiev' : phoneZone;
  return zone && REGION_BY_TIME_ZONE[zone] ? zone : 'Europe/Warsaw';
}

/** "PL" for Europe/Warsaw; Poland when the zone is not one of the listed countries. */
export function regionForTimeZone(timeZone: string): string {
  return REGION_BY_TIME_ZONE[timeZone === 'Europe/Kyiv' ? 'Europe/Kiev' : timeZone] ?? 'PL';
}

/** The usual currency of the salon's country; euro in the euro area and Montenegro. */
export function currencyForTimeZone(timeZone: string): Currency {
  return CURRENCY_BY_REGION[regionForTimeZone(timeZone)] ?? 'EUR';
}
