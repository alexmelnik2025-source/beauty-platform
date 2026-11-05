'use client';

import Link from 'next/link';
import { ClientNav } from '@/components/client/ClientNav';
import { LanguageSwitch } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

/**
 * Home page for clients (task 180): find a salon or open "My visits"; the salon dashboard is a
 * link at the bottom ("Dla salonów").
 */
export default function Home() {
  const { t, locale } = useI18n();
  const n = t.clientNav;
  return (
    <div className="booking">
      <ClientNav />
      <main className="narrow client-home">
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <LanguageSwitch />
        </div>
        <h1>{n.homeTitle}</h1>
        <p className="muted">{n.homeLead}</p>
        <Link className="client-home-choice client-home-choice--main" href={`/${locale}/salons`}>
          <strong>{n.findSalon}</strong>
          <span className="small muted">{n.findSalonHint}</span>
        </Link>
        <Link className="client-home-choice" href={`/${locale}/c`}>
          <strong>{n.myVisits}</strong>
          <span className="small muted">{n.myVisitsHint}</span>
        </Link>
        <div className="client-home-salons small">
          <Link href={`/${locale}/login`}>{n.forSalons}</Link>
          <span className="muted"> — {n.forSalonsHint}</span>
        </div>
      </main>
    </div>
  );
}
