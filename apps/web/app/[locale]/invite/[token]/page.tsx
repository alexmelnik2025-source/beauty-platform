'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthPage } from '@/components/AuthPage';
import { ErrorBox, Spinner } from '@/components/ui';
import { api, refreshSession } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';
import type { Me } from '@/lib/types';

interface Preview {
  organizationName: string;
  role: 'manager' | 'staff';
  email: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}

export default function InvitePage() {
  const { t, locale } = useI18n();
  const { token } = useParams<{ token: string }>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'joined'>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const p = await api<Preview>(`/v1/invitations/${token}`, { auth: false });
      setPreview(p);
      if (p.status !== 'pending') {
        setState('invalid');
        return;
      }
      if (await refreshSession()) setMe(await api<Me>('/v1/me'));
      setState('ready');
    })().catch(() => setState('invalid'));
  }, [token]);

  async function accept() {
    setBusy(true);
    setError('');
    try {
      await api(`/v1/invitations/${token}/accept`, { method: 'POST' });
      setState('joined');
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  }

  const here = `/${locale}/invite/${token}`;
  return (
    <AuthPage>
      {state === 'loading' ? <Spinner /> : null}
      {state === 'invalid' ? <p className="note">{t.invite.invalid}</p> : null}
      {preview && state !== 'invalid' && state !== 'loading' ? (
        <>
          <div className="stack">
            <h1>{t.invite.title}</h1>
            <p>{fill(t.invite.lead, { org: preview.organizationName })}</p>
            <p className="muted small">
              {t.team.roles[preview.role]} · {fill(t.invite.forEmail, { email: preview.email })}
            </p>
          </div>
          <ErrorBox>{error}</ErrorBox>
          {state === 'joined' ? (
            <>
              <p className="note">{t.invite.joined}</p>
              <Link className="btn btn--block" href={`/${locale}/app/calendar`}>
                {t.nav.calendar}
              </Link>
            </>
          ) : me && me.user.email === preview.email ? (
            <button
              type="button"
              className="btn btn--block"
              disabled={busy}
              onClick={() => void accept()}
            >
              {t.invite.accept}
            </button>
          ) : me ? (
            <p className="note">{fill(t.invite.wrongEmail, { email: preview.email })}</p>
          ) : (
            <>
              <p className="small">{t.invite.signInFirst}</p>
              <Link
                className="btn btn--block"
                href={`/${locale}/login?next=${encodeURIComponent(here)}`}
              >
                {t.auth.signIn}
              </Link>
              <Link className="btn btn--quiet btn--block" href={`/${locale}/register`}>
                {t.auth.createAccount}
              </Link>
            </>
          )}
        </>
      ) : null}
    </AuthPage>
  );
}
