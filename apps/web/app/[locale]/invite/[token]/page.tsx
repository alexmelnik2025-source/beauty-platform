'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthPage } from '@/components/AuthPage';
import { FieldError, Spinner } from '@/components/ui';
import { api, ApiError, refreshSession, setAccessToken } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';
import type { InvitationPreview as Preview, Me } from '@/lib/types';

/** Task 658: answers about the typed code itself, said at the code field (owner's rule). */
const CODE_ERRORS = new Set(['INVALID_CODE', 'CODE_EXPIRED']);

export default function InvitePage() {
  const { t, locale } = useI18n();
  const { token } = useParams<{ token: string }>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'joined'>('loading');
  /**
   * Task 774 (owner's rule: errors where the action is): a refusal that is not about the code (no
   * connection, too many tries, …) is said under the button that was pressed — "Wyślij kod",
   * "Wyślij kod ponownie" or "Dołącz do zespołu" — not as a box above it.
   */
  const [error, setError] = useState<{ on: 'accept' | 'send' | 'resend'; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  /** Not signed in: a one-time code to the invited address (no password, no sign-up). */
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  /** Task 658: a wrong or expired code, under the code field; typing takes it away. */
  const [codeError, setCodeError] = useState('');

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
    setError(null);
    try {
      await api(`/v1/invitations/${token}/accept`, { method: 'POST' });
      setState('joined');
    } catch (err) {
      setError({ on: 'accept', text: errorText(t, err) });
      setBusy(false);
    }
  }

  async function sendCode() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    setCodeError('');
    try {
      await api('/v1/auth/code', {
        method: 'POST',
        auth: false,
        body: { email: preview.email, locale },
      });
      setCodeSent(true);
    } catch (err) {
      setError({ on: codeSent ? 'resend' : 'send', text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  }

  /** Signing in with the code accepts every invitation for this address at once. */
  async function signInWithCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!preview) return;
    setError(null);
    // Task 686 (owner's rule: errors at the field): an empty or short code used to get the
    // browser's bubble; now it is said under the code field and the cursor goes there.
    const typed = code.trim();
    if (!/^\d{6}$/.test(typed)) {
      setCodeError(typed ? t.errors.INVALID_CODE : t.onboarding.fieldRequired);
      e.currentTarget.querySelector<HTMLInputElement>('input[name="code"]')?.focus();
      return;
    }
    setBusy(true);
    setCodeError('');
    try {
      const res = await api<{ accessToken: string }>('/v1/auth/code/verify', {
        method: 'POST',
        auth: false,
        body: { email: preview.email, code: code.trim(), clientType: 'web', locale },
      });
      setAccessToken(res.accessToken);
      setState('joined');
    } catch (err) {
      if (err instanceof ApiError && CODE_ERRORS.has(err.code)) setCodeError(errorText(t, err));
      else setError({ on: 'accept', text: errorText(t, err) });
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
          {state === 'joined' ? (
            <>
              <p className="note">{t.invite.joined}</p>
              <Link className="btn btn--block" href={`/${locale}/app/calendar`}>
                {t.nav.calendar}
              </Link>
            </>
          ) : me && me.user.email === preview.email ? (
            <>
              <button
                type="button"
                className="btn btn--block"
                disabled={busy}
                aria-describedby={error?.on === 'accept' ? 'invite-accept-error' : undefined}
                onClick={() => void accept()}
              >
                {t.invite.accept}
              </button>
              <FieldError
                id="invite-accept-error"
                text={error?.on === 'accept' ? error.text : undefined}
              />
            </>
          ) : me ? (
            <p className="note">{fill(t.invite.wrongEmail, { email: preview.email })}</p>
          ) : codeSent ? (
            <form noValidate className="form" onSubmit={(e) => void signInWithCode(e)}>
              <p className="small" role="status">
                {fill(t.invite.codeSent, { email: preview.email })}
              </p>
              <label className="field">
                <span>{t.invite.code}</span>
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  aria-invalid={codeError ? true : undefined}
                  aria-describedby={codeError ? 'invite-code-error' : undefined}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/\D/g, ''));
                    setCodeError('');
                    setError(null);
                  }}
                />
                <FieldError id="invite-code-error" text={codeError} />
              </label>
              <button
                className="btn btn--block"
                disabled={busy}
                aria-describedby={error?.on === 'accept' ? 'invite-accept-error' : undefined}
              >
                {t.invite.accept}
              </button>
              <FieldError
                id="invite-accept-error"
                text={error?.on === 'accept' ? error.text : undefined}
              />
              <button
                type="button"
                className="btn btn--quiet btn--block"
                disabled={busy}
                aria-describedby={error?.on === 'resend' ? 'invite-resend-error' : undefined}
                onClick={() => void sendCode()}
              >
                {t.invite.resend}
              </button>
              <FieldError
                id="invite-resend-error"
                text={error?.on === 'resend' ? error.text : undefined}
              />
            </form>
          ) : (
            <>
              <p className="small">{t.invite.signInFirst}</p>
              <button
                type="button"
                className="btn btn--block"
                disabled={busy}
                aria-describedby={error?.on === 'send' ? 'invite-send-error' : undefined}
                onClick={() => void sendCode()}
              >
                {t.invite.sendCode}
              </button>
              <FieldError
                id="invite-send-error"
                text={error?.on === 'send' ? error.text : undefined}
              />
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
