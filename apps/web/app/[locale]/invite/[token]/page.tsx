'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthPage } from '@/components/AuthPage';
import { ErrorBox, Spinner } from '@/components/ui';
import { api, refreshSession, setAccessToken } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';
import type { InvitationPreview as Preview, Me } from '@/lib/types';

export default function InvitePage() {
  const { t, locale } = useI18n();
  const { token } = useParams<{ token: string }>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'joined'>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** Not signed in: a one-time code to the invited address (no password, no sign-up). */
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');

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

  async function sendCode() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      await api('/v1/auth/code', {
        method: 'POST',
        auth: false,
        body: { email: preview.email, locale },
      });
      setCodeSent(true);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  /** Signing in with the code accepts every invitation for this address at once. */
  async function signInWithCode(e: FormEvent) {
    e.preventDefault();
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const res = await api<{ accessToken: string }>('/v1/auth/code/verify', {
        method: 'POST',
        auth: false,
        body: { email: preview.email, code: code.trim(), clientType: 'web', locale },
      });
      setAccessToken(res.accessToken);
      setState('joined');
    } catch (err) {
      setError(errorText(t, err));
    } finally {
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
          ) : codeSent ? (
            <form className="form" onSubmit={signInWithCode}>
              <p className="small" role="status">
                {fill(t.invite.codeSent, { email: preview.email })}
              </p>
              <label className="field">
                <span>{t.invite.code}</span>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
              </label>
              <button className="btn btn--block" disabled={busy}>
                {t.invite.accept}
              </button>
              <button
                type="button"
                className="btn btn--quiet btn--block"
                disabled={busy}
                onClick={() => void sendCode()}
              >
                {t.invite.resend}
              </button>
            </form>
          ) : (
            <>
              <p className="small">{t.invite.signInFirst}</p>
              <button
                type="button"
                className="btn btn--block"
                disabled={busy}
                onClick={() => void sendCode()}
              >
                {t.invite.sendCode}
              </button>
              <Link
                className="btn btn--quiet btn--block"
                href={`/${locale}/login?next=${encodeURIComponent(here)}`}
              >
                {t.invite.havePassword}
              </Link>
            </>
          )}
        </>
      ) : null}
    </AuthPage>
  );
}
