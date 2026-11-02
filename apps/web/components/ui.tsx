'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { LOCALES, useI18n } from '@/lib/i18n';

export function Wordmark({ href }: { href?: string }) {
  const { locale } = useI18n();
  return (
    <Link href={href ?? `/${locale}`} className="wordmark" aria-label="GESTALT">
      GESTALT
    </Link>
  );
}

/** Links to the same page in the other languages; `query` (e.g. "?embed=1") is kept. */
export function LanguageSwitch({ query = '' }: { query?: string }) {
  const { locale, t } = useI18n();
  const pathname = usePathname() ?? `/${locale}`;
  const rest = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, '');
  return (
    <nav className="lang" aria-label={t.common.language}>
      {LOCALES.map((l) => (
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

/**
 * Side panel on a computer, bottom sheet on a phone. Escape and the backdrop close it;
 * focus moves into the panel when it opens.
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
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" tabIndex={-1} ref={ref}>
        <div className="sheet-head">
          <h2>{title}</h2>
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
