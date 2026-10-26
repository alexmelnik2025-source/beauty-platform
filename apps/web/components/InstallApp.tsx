'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { installMode, onInstallChange, promptInstall, type InstallMode } from '@/lib/pwa';

/**
 * "Install the app" block: a button where the browser can install it, the Safari steps on
 * iPhone and iPad, nothing once the app is already installed.
 */
export function InstallApp({
  compact = false,
  lead,
}: {
  compact?: boolean;
  /** What the app is for (default: the salon cabinet text). */
  lead?: string;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<InstallMode>('installed');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const update = () => setMode(installMode());
    update();
    return onInstallChange(update);
  }, []);

  if (mode === 'installed') return null;

  const help =
    mode === 'ios' ? (
      <ol className="small install-steps">
        <li>{t.install.iosStep1}</li>
        <li>{t.install.iosStep2}</li>
        <li>{t.install.iosStep3}</li>
      </ol>
    ) : (
      <p className="small muted">{t.install.manual}</p>
    );

  const button = (
    <button
      type="button"
      className={compact ? 'link-btn' : 'btn btn--block'}
      onClick={() => {
        if (mode === 'prompt') void promptInstall();
        else setOpen((v) => !v);
      }}
    >
      {t.install.button}
    </button>
  );

  if (compact) {
    return (
      <div className="install-app">
        {button}
        {open ? help : null}
      </div>
    );
  }

  return (
    <section className="install-app install-app--card">
      <strong>{t.install.title}</strong>
      <p className="small muted">{lead ?? t.install.lead}</p>
      {button}
      {open ? help : null}
    </section>
  );
}
