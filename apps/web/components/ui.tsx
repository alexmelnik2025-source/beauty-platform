'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { DASHBOARD_LOCALES, LOCALES, useI18n } from '@/lib/i18n';

export function Wordmark({ href }: { href?: string }) {
  const { locale } = useI18n();
  return (
    <Link href={href ?? `/${locale}`} className="wordmark" aria-label="GESTALT">
      GESTALT
    </Link>
  );
}

/**
 * Links to the same page in the other languages; `query` (e.g. "?embed=1") is kept. The salon
 * dashboard offers only the languages it is fully translated into.
 */
export function LanguageSwitch({ query = '' }: { query?: string }) {
  const { locale, t } = useI18n();
  const pathname = usePathname() ?? `/${locale}`;
  const rest = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, '');
  const dashboard = /^\/(app|login|register|verify-email|invite)(\/|$)/.test(rest);
  return (
    <nav className="lang" aria-label={t.common.language}>
      {(dashboard ? DASHBOARD_LOCALES : LOCALES).map((l) => (
        <a key={l} href={`/${l}${rest}${query}`} aria-current={l === locale} lang={l}>
          {l.toUpperCase()}
        </a>
      ))}
    </nav>
  );
}

export function Spinner({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="center" role="status">
      <div className="spinner" />
      <span className="visually-hidden">{label ?? t.common.loading}</span>
    </div>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="alert" role="alert">
      {children}
    </div>
  );
}

/** What Tab can reach inside a sheet. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Side panel on a computer, bottom sheet on a phone. Escape and the backdrop close it;
 * focus moves into the panel when it opens, Tab stays inside, and closing returns the focus.
 */

export function Sheet({
  title,
  onClose,
  children,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // The latest onClose, so a parent re-render does not move the focus back to the sheet.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    // Task 230: keyboard — focus goes into the sheet, Tab stays inside it, Escape closes it,
    // and the focus returns to what opened it (e.g. the visit in the calendar).
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const sheet = ref.current;
    sheet?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !sheet) return;
      const active = document.activeElement;
      // Another sheet on top of this one keeps its own focus.
      if (active && active !== document.body && !sheet.contains(active)) return;
      const items = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.getClientRects().length > 0,
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && (active === first || active === sheet)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={ref}
      >
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t.common.close}>
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </>
  );
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
