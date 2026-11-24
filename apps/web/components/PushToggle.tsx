'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';
import { disablePush, enablePush, pushState, type PushState } from '@/lib/pwa';
import { FieldError } from './ui';

/** "Notifications on this phone": push about new, moved and cancelled appointments. */
export function PushToggle() {
  const { t } = useI18n();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    pushState(api)
      .then((s) => alive && setState(s))
      .catch(() => alive && setState('unsupported'));
    return () => {
      alive = false;
    };
  }, []);

  if (state === null || state === 'server-off') return null;

  async function toggle(on: boolean) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setState(on ? await enablePush(api) : await disablePush(api));
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Task 840 (owner's rule: errors where the action is): a refused "Włącz powiadomienia" /
   * "Wyłącz na tym urządzeniu" is said right under that button with the "!" mark and read out
   * with it — not as a separate line at the bottom of the card.
   */
  const describedBy = error ? 'push-toggle-error' : undefined;

  const hint: Partial<Record<PushState, string>> = {
    unsupported: t.push.unsupported,
    'needs-install': t.push.needsInstall,
    denied: t.push.denied,
  };

  return (
    <section className="install-app install-app--card">
      <strong>{t.push.title}</strong>
      <p className="small muted">{state === 'on' ? t.push.onLead : t.push.lead}</p>
      {state === 'on' ? (
        <button
          type="button"
          className="btn btn--quiet btn--block"
          disabled={busy}
          aria-describedby={describedBy}
          onClick={() => void toggle(false)}
        >
          {t.push.turnOff}
        </button>
      ) : state === 'off' ? (
        <button
          type="button"
          className="btn btn--block"
          disabled={busy}
          aria-describedby={describedBy}
          onClick={() => void toggle(true)}
        >
          {t.push.turnOn}
        </button>
      ) : (
        <p className="small">{hint[state]}</p>
      )}
      {state === 'on' || state === 'off' ? (
        <FieldError id="push-toggle-error" text={error || undefined} />
      ) : null}
    </section>
  );
}
