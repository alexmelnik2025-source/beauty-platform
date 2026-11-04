/**
 * Currencies a salon can price its services in (launch task L5: EU, the CIS, Albania, Turkey).
 * ISO 4217 codes. Every amount in the API is in hundredths of the salon's currency
 * (the fields are still called `…Grosze`): 50.00 PLN = 5000, 50.00 EUR = 5000, 500 TRY = 50000.
 * Intl decides how many decimals are shown.
 */
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
  'USD',
] as const;

export type Currency = (typeof CURRENCIES)[number];

export const DEFAULT_CURRENCY: Currency = 'PLN';

/** "45,00 zł", "€45.00": an amount in hundredths of the currency, in the reader's language. */
export function formatMoney(hundredths: number, currency: string, localeTag: string): string {
  return new Intl.NumberFormat(localeTag, { style: 'currency', currency }).format(hundredths / 100);
}
