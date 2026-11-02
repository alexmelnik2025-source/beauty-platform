'use client';

import Link from 'next/link';
import { AuthPage } from '@/components/AuthPage';
import { useI18n } from '@/lib/i18n';

export default function Home() {
  const { t, locale } = useI18n();
  return (
    <AuthPage>
      <h1>{t.auth.loginTitle}</h1>
      <p className="muted">{t.auth.loginLead}</p>
      <div className="stack">
        <Link className="btn btn--block" href={`/${locale}/login`}>
          {t.auth.signIn}
        </Link>
        <Link className="btn btn--quiet btn--block" href={`/${locale}/register`}>
          {t.auth.createAccount}
        </Link>
      </div>
      <p className="small" style={{ marginTop: 24 }}>
        <Link href={`/${locale}/salons`}>{t.directory.title}</Link>
      </p>
    </AuthPage>
  );
}
