'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { DICTIONARIES, type Locale } from './locales';
import type { Dict } from './pl';

export * from './locales';

const I18nContext = createContext<{ locale: Locale; t: Dict } | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale, t: DICTIONARIES[locale] }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): { locale: Locale; t: Dict } {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n outside I18nProvider');
  return value;
}

/** A translated message for an API error code (falls back to a generic one). */
export function errorText(t: Dict, error: unknown): string {
  if (error instanceof Error && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    if (code === 'NETWORK') return t.errors.network;
    const known = (t.errors as Record<string, string>)[code];
    if (known) return known;
  }
  return t.errors.generic;
}

/**
 * Salon side (calendar): a taken time is not "just taken" — the specialist already has a
 * visit then (owner's test 03.11.2026, T10).
 */
export function calendarErrorText(t: Dict, error: unknown): string {
  if (error instanceof Error && 'code' in error && error.code === 'SLOT_TAKEN') {
    return t.errors.STAFF_BUSY;
  }
  return errorText(t, error);
}
