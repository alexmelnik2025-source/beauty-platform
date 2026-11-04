/**
 * Salons outside Poland (launch task L5): the country of a salon follows from its time zone, and
 * the time zone suggests the currency and the phone code. The lists cover the EU, the rest of
 * Europe, the CIS, Albania and Turkey.
 */
import type { Currency } from '@beauty/api-client';

/** The country of a time zone. Europe/Kiev is the name the server (ICU) knows for Kyiv. */
const REGION_BY_TIME_ZONE: Record<string, string> = {
  'Europe/Warsaw': 'PL',
  'Europe/Kyiv': 'UA',
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

/** "PL" for Europe/Warsaw; Poland when the zone is not one of the listed countries. */
export function regionForTimeZone(timeZone: string): string {
  return REGION_BY_TIME_ZONE[timeZone] ?? 'PL';
}

/** The usual currency of the salon's country; euro in the euro area and Montenegro. */
export function currencyForTimeZone(timeZone: string): Currency {
  return CURRENCY_BY_REGION[regionForTimeZone(timeZone)] ?? 'EUR';
}

/**
 * Time zones a salon can choose: one per country (Kazakhstan and Uzbekistan have more), the ones
 * this browser knows. Poland first, then by country name in the reader's language.
 */
export function salonTimeZones(localeTag: string): { timeZone: string; label: string }[] {
  const known = new Set(Intl.supportedValuesOf('timeZone'));
  return Object.keys(REGION_BY_TIME_ZONE)
    .filter((zone) => zone !== 'Europe/Kyiv' && known.has(zone))
    .map((timeZone) => ({ timeZone, label: timeZoneLabel(timeZone, localeTag) }))
    .sort((a, b) =>
      a.timeZone === 'Europe/Warsaw'
        ? -1
        : b.timeZone === 'Europe/Warsaw'
          ? 1
          : a.label.localeCompare(b.label, localeTag),
    );
}

/** "Turcja (Istanbul)": the country in the reader's language and the zone's city. */
export function timeZoneLabel(timeZone: string, localeTag: string): string {
  const region = REGION_BY_TIME_ZONE[timeZone];
  const city = (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
  if (!region) return timeZone;
  const country = new Intl.DisplayNames([localeTag], { type: 'region' }).of(region) ?? region;
  return `${country} (${city === 'Kiev' ? 'Kyiv' : city})`;
}

/** The browser's own time zone when it is one a salon can choose (Kyiv as the server names it). */
export function browserSalonTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const named = zone === 'Europe/Kyiv' ? 'Europe/Kiev' : zone;
  return REGION_BY_TIME_ZONE[named] ? named : 'Europe/Warsaw';
}
