'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  androidIntentLink,
  bannerHidden,
  hideBanner,
  saveBookingPlace,
  type BookingPlace,
  type StoreLinks,
} from '@/lib/install-banner';
import { installMode, onInstallChange, promptInstall, startPwa, type InstallMode } from '@/lib/pwa';

/**
 * Task Q2 (part 4): one small row above the salon's booking page — "Install the app".
 *
 * Where the browser can install "My visits" itself (Chrome, Edge, Android) the button opens its
 * dialog; on iPhone and iPad it shows the Safari steps or, once the app is in the App Store, the
 * store link; on Android with a Google Play page — an intent link that opens the app when it is
 * already installed. Whatever way the client chooses, where they were (salon, service,
 * specialist) is kept, so the installed app continues the booking there.
 *
 * The banner never gets in the way: one tap on × closes it for HIDE_DAYS, it is not shown in the
 * installed app nor in the window on the salon's own site.
 */
export function InstallBanner({ place, stores }: { place: BookingPlace; stores: StoreLinks }) {
  const { t } = useI18n();
  const b = t.installBanner;
  const [mode, setMode] = useState<InstallMode>('installed');
  const [hidden, setHidden] = useState(true);
  const [android, setAndroid] = useState(false);
  const [help, setHelp] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    startPwa();
    setHidden(bannerHidden());
    setAndroid(/Android/i.test(navigator.userAgent));
    const update = () => setMode(installMode());
    update();
    return onInstallChange(update);
  }, []);

  if (hidden || mode === 'installed') return null;

  function close() {
    hideBanner();
    setHidden(true);
  }

  /** Remembers where the client is: the app continues the booking from here. */
  function keepPlace() {
    saveBookingPlace(place);
  }

  async function install() {
    keepPlace();
    if (mode === 'prompt') {
      const accepted = await promptInstall();
      if (accepted) setDone(true);
      return;
    }
    setHelp((v) => !v);
  }

  const intent = android ? androidIntentLink(place, stores) : null;
  const storeLink = mode === 'ios' ? stores.appStoreUrl : intent;

  return (
    <aside className="install-banner" data-testid="install-banner" aria-label={b.title}>
      <div className="install-banner-row">
        <img
          className="install-banner-icon"
          src="/icons/icon-192.png"
          alt=""
          width={36}
          height={36}
        />
        <div className="install-banner-text">
          <strong>{b.title}</strong>
          <span className="small muted">{done ? b.done : b.lead}</span>
        </div>
        {done ? null : storeLink ? (
          <a className="btn btn--small" href={storeLink} onClick={keepPlace} rel="noopener">
            {b.get}
          </a>
        ) : (
          <button
            type="button"
            className="btn btn--small"
            aria-expanded={mode === 'prompt' ? undefined : help}
            onClick={() => void install()}
          >
            {b.install}
          </button>
        )}
        <button type="button" className="install-banner-close" aria-label={b.close} onClick={close}>
          ×
        </button>
      </div>
      {help && !done ? (
        <div className="install-banner-help small" data-testid="install-banner-help">
          {mode === 'ios' ? (
            <ol className="install-steps">
              <li>{t.install.iosStep1}</li>
              <li>{t.install.iosStep2}</li>
              <li>{t.install.iosStep3}</li>
            </ol>
          ) : (
            <p className="muted">{t.install.manual}</p>
          )}
          {/* The store pages, once the apps are published (empty until then). */}
          {stores.appStoreUrl || stores.playStoreUrl ? (
            <p className="muted">
              {stores.appStoreUrl ? (
                <a href={stores.appStoreUrl} onClick={keepPlace} rel="noopener">
                  App Store
                </a>
              ) : null}
              {stores.appStoreUrl && stores.playStoreUrl ? ' · ' : null}
              {stores.playStoreUrl ? (
                <a href={stores.playStoreUrl} onClick={keepPlace} rel="noopener">
                  Google Play
                </a>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
