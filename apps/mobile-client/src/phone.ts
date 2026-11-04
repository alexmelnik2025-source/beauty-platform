/**
 * Phone numbers outside Poland too (launch task L5): the salon's country code is suggested from
 * its time zone and a number typed without a code gets it. The same rules as apps/web/lib/phone.ts
 * (where the client can also pick the country from a list).
 */

/** Country calling code by the salon's time zone (EU, the rest of Europe, the CIS, Albania, Turkey). */
const DIAL_BY_TIME_ZONE: Record<string, string> = {
  'Europe/Warsaw': '48',
  'Europe/Kyiv': '380',
  'Europe/Kiev': '380',
  'Europe/Minsk': '375',
  'Europe/Vilnius': '370',
  'Europe/Riga': '371',
  'Europe/Tallinn': '372',
  'Europe/Berlin': '49',
  'Europe/Prague': '420',
  'Europe/Bratislava': '421',
  'Europe/Vienna': '43',
  'Europe/Budapest': '36',
  'Europe/Bucharest': '40',
  'Europe/Sofia': '359',
  'Europe/Athens': '30',
  'Asia/Nicosia': '357',
  'Europe/Rome': '39',
  'Europe/Malta': '356',
  'Europe/Madrid': '34',
  'Europe/Lisbon': '351',
  'Europe/Paris': '33',
  'Europe/Brussels': '32',
  'Europe/Amsterdam': '31',
  'Europe/Luxembourg': '352',
  'Europe/Dublin': '353',
  'Europe/Copenhagen': '45',
  'Europe/Stockholm': '46',
  'Europe/Helsinki': '358',
  'Europe/Ljubljana': '386',
  'Europe/Zagreb': '385',
  'Europe/London': '44',
  'Europe/Oslo': '47',
  'Europe/Zurich': '41',
  'Europe/Tirane': '355',
  'Europe/Istanbul': '90',
  'Europe/Skopje': '389',
  'Europe/Belgrade': '381',
  'Europe/Podgorica': '382',
  'Europe/Sarajevo': '387',
  'Europe/Chisinau': '373',
  'Asia/Tbilisi': '995',
  'Asia/Yerevan': '374',
  'Asia/Baku': '994',
  'Asia/Almaty': '7',
  'Asia/Qostanay': '7',
  'Asia/Aqtobe': '7',
  'Asia/Bishkek': '996',
  'Asia/Tashkent': '998',
  'Asia/Samarkand': '998',
  'Asia/Dushanbe': '992',
  'Asia/Ashgabat': '993',
  'Europe/Moscow': '7',
};

/** "48" for a salon in Europe/Warsaw, "90" in Europe/Istanbul; Poland when the zone is not listed. */
export function dialForTimeZone(timeZone: string): string {
  return DIAL_BY_TIME_ZONE[timeZone] ?? '48';
}

/**
 * "600 100 200" → "+48600100200" (with the salon's code); "0048…" → "+48…";
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
