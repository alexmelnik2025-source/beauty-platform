'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';
import { ErrorBox, LanguageSwitch } from '../ui';

/**
 * Task 165c: "unsubscribe" from the salon's messages. The link only opens this page; the
 * consent is withdrawn by the button (mail scanners that open links change nothing).
 */
export function Unsubscribe({ token }: { token: string }) {
  const { t } = useI18n();
  const u = t.unsubscribe;
  const [salon, setSalon] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const done = await api<{ salonName: string }>('/v1/public/unsubscribe', {
        method: 'POST',
        body: { token },
        auth: false,
      });
      setSalon(done.salonName);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="booking">
      <header className="salon-head">
        <div className="salon-head-inner">
          <div className="top">
            <span className="small muted">{u.title}</span>
            <LanguageSwitch />
          </div>
          <h1 className="salon-name">{u.title}</h1>
        </div>
      </header>
      <main className="narrow stack">
        <ErrorBox>{error}</ErrorBox>
        {salon ? (
          <p className="note" role="status">
            {fill(u.done, { salon })}
          </p>
        ) : (
          <>
            <p>{u.lead}</p>
            <button type="button" className="btn" disabled={busy} onClick={confirm}>
              {u.button}
            </button>
          </>
        )}
      </main>
    </div>
  );
}
