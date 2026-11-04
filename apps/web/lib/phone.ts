/**
 * Phone numbers outside Poland too (launch task L5): the salon's country code is suggested from its
 * time zone, the client can pick another one, and a number typed without a code gets the chosen one.
 * The API stores E.164 (+48600100200). Same rules as apps/mobile-client/src/phone.ts.
 */

/** Country calling codes of the EU, the rest of Europe, the CIS, Albania and Turkey; Poland first. */
export const DIAL_CODES: readonly { region: string; dial: string }[] = [
  { region: 'PL', dial: '48' },
  { region: 'UA', dial: '380' },
  { region: 'BY', dial: '375' },
  { region: 'LT', dial: '370' },
  { region: 'LV', dial: '371' },
  { region: 'EE', dial: '372' },
  { region: 'DE', dial: '49' },
  { region: 'CZ', dial: '420' },
  { region: 'SK', dial: '421' },
  { region: 'AT', dial: '43' },
  { region: 'HU', dial: '36' },
  { region: 'RO', dial: '40' },
  { region: 'BG', dial: '359' },
  { region: 'GR', dial: '30' },
  { region: 'CY', dial: '357' },
  { region: 'IT', dial: '39' },
  { region: 'MT', dial: '356' },
  { region: 'ES', dial: '34' },
  { region: 'PT', dial: '351' },
  { region: 'FR', dial: '33' },
  { region: 'BE', dial: '32' },
  { region: 'NL', dial: '31' },
  { region: 'LU', dial: '352' },
  { region: 'IE', dial: '353' },
  { region: 'DK', dial: '45' },
  { region: 'SE', dial: '46' },
  { region: 'FI', dial: '358' },
  { region: 'SI', dial: '386' },
  { region: 'HR', dial: '385' },
  { region: 'GB', dial: '44' },
  { region: 'NO', dial: '47' },
  { region: 'CH', dial: '41' },
  { region: 'AL', dial: '355' },
  { region: 'TR', dial: '90' },
  { region: 'MK', dial: '389' },
  { region: 'RS', dial: '381' },
  { region: 'ME', dial: '382' },
  { region: 'BA', dial: '387' },
  { region: 'MD', dial: '373' },
  { region: 'GE', dial: '995' },
  { region: 'AM', dial: '374' },
  { region: 'AZ', dial: '994' },
  { region: 'KZ', dial: '7' },
  { region: 'KG', dial: '996' },
  { region: 'UZ', dial: '998' },
  { region: 'TJ', dial: '992' },
  { region: 'TM', dial: '993' },
  { region: 'RU', dial: '7' },
];

/** The country of a salon's time zone, for the time zones of the countries above. */
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

/** "48" for a salon in Europe/Warsaw, "90" in Europe/Istanbul; Poland when the zone is not listed. */
export function dialForTimeZone(timeZone: string): string {
  const region = REGION_BY_TIME_ZONE[timeZone] ?? 'PL';
  return DIAL_CODES.find((c) => c.region === region)?.dial ?? '48';
}

/** The country code a typed number starts with ("+380 50…" → "380"), the longest that fits. */
export function dialOf(value: string): string | null {
  const digits = value.replace(/[\s()-]/g, '');
  if (!digits.startsWith('+')) return null;
  const match = DIAL_CODES.map((c) => c.dial)
    .filter((dial) => digits.startsWith(`+${dial}`))
    .sort((a, b) => b.length - a.length)[0];
  return match ?? null;
}

/** Puts another country code in front of a number, replacing the one it had. */
export function withDial(value: string, dial: string): string {
  const current = dialOf(value);
  const rest = current
    ? value.replace(/^[\s()-]*\+/, '').slice(current.length)
    : value.replace(/^[\s()-]*\+?/, '');
  return `+${dial} ${rest.trimStart()}`;
}

/**
 * "600 100 200" → "+48600100200" (with the code chosen for the salon); "0048…" → "+48…";
 * "050 123 45 67" in Ukraine → "+380501234567" (the national 0 is dropped); "+…" is kept.
 */
export function normalizePhone(value: string, dial = '48'): string {
  const compact = value.replace(/[\s()-]/g, '');
  if (compact.startsWith('+')) return compact;
  if (compact.startsWith('00')) return `+${compact.slice(2)}`;
  if (!/^\d{6,14}$/.test(compact)) return compact;
  // The national 0 is dropped (Ukraine, Turkey, the UK…), except in Italy where it is part of the number.
  return `+${dial}${dial === '39' ? compact : compact.replace(/^0/, '')}`;
}

/** "Polska +48" in the reader's language. */
export function dialLabel(region: string, dial: string, localeTag: string): string {
  const name = new Intl.DisplayNames([localeTag], { type: 'region' }).of(region) ?? region;
  return `${name} +${dial}`;
}
