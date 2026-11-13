/**
 * Task 375: "Prowizje" in the business app — what the owner types as a specialist's
 * commission and how a percent is shown. No React Native imports (tested with Vitest).
 */

/** "45,5" or "45.5" → 45.5; '' → null (no commission); anything else → undefined. */
export function parsePercent(text: string): number | null | undefined {
  const value = text.trim().replace(',', '.');
  if (value === '') return null;
  if (!/^\d{1,3}(\.\d)?$/.test(value)) return undefined;
  const percent = Number(value);
  return percent <= 100 ? percent : undefined;
}

const INTL_LOCALE = { pl: 'pl-PL', uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' } as const;

/** 45.5 → "45,5" (pl, uk, ru) / "45.5" (en): as the owner would type it. */
export function percentInput(percent: number | null, locale: keyof typeof INTL_LOCALE): string {
  if (percent === null) return '';
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    maximumFractionDigits: 1,
    useGrouping: false,
  }).format(percent);
}

/** 45.5 → "45,5%". */
export function percentText(percent: number, locale: keyof typeof INTL_LOCALE): string {
  return `${percentInput(percent, locale)}%`;
}
