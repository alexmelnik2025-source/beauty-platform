'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AuthPage } from '@/components/AuthPage';
import { Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function VerifyEmailPage() {
  const { t, locale } = useI18n();
  const [state, setState] = useState<'working' | 'ok' | 'failed'>('working');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    api('/v1/auth/verify-email', { method: 'POST', auth: false, body: { token } })
      .then(() => setState('ok'))
      .catch(() => setState('failed'));
  }, []);

  return (
    <AuthPage>
      {state === 'working' ? <Spinner label={t.auth.verifying} /> : null}
      {state === 'ok' ? (
        <>
          <h1>{t.auth.verified}</h1>
          <Link className="btn btn--block" href={`/${locale}/login`}>
            {t.auth.signIn}
          </Link>
        </>
      ) : null}
      {state === 'failed' ? <p className="alert">{t.auth.verifyFailed}</p> : null}
    </AuthPage>
  );
}
