'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { ClientAppointment, VisitCoupons } from '@/lib/types';
import { AppointmentManager } from '../booking/ManageAppointment';
import { ErrorBox } from '../ui';
import { bookAgainHref } from './ClientVisits';

/** One visit in the "My visits" app: move, cancel, coupons, book again. */
export function ClientVisit({ id }: { id: string }) {
  const { t, locale } = useI18n();
  return (
    <AppointmentManager<ClientAppointment>
      endpoint={`/v1/client/appointments/${id}`}
      title={t.visits.title}
      top={
        <Link className="link-btn small" href={`/${locale}/c`}>
          ← {t.visits.allVisits}
        </Link>
      }
      extra={(a, update) => {
        const href = bookAgainHref(locale, a);
        return (
          <>
            <VisitCouponsPicker appointment={a} onChanged={update} />
            {href ? (
              <Link className="btn btn--quiet btn--block" href={href}>
                {t.visits.bookAgain}
              </Link>
            ) : null}
          </>
        );
      }}
    />
  );
}

/**
 * The client's coupons for this visit (task 10d): the one in use with the price to pay, and
 * the others with what each takes off — until the salon's deadline for changes.
 */
function VisitCouponsPicker({
  appointment: a,
  onChanged,
}: {
  appointment: ClientAppointment;
  onChanged: (changed: ClientAppointment) => void;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const money = (hundredths: number) => formatPrice(hundredths, a.currency, tag);
  const url = `/v1/client/appointments/${a.id}/coupons`;
  const open = a.status === 'confirmed' && a.canChange;
  const [coupons, setCoupons] = useState<VisitCoupons | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let live = true;
    api<VisitCoupons>(url, { auth: false })
      .then((data) => {
        if (live) setCoupons(data);
      })
      // Without the list the visit still works; coupons are simply not offered.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [url, open, a.discountGrosze]);

  async function change(path: string, body?: object) {
    setBusy(true);
    setError('');
    try {
      onChanged(await api<ClientAppointment>(path, { method: 'POST', auth: false, body }));
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  const offered = open ? (coupons?.available ?? []) : [];
  if (a.coupons.length === 0 && offered.length === 0) return null;
  return (
    <section className="stack" style={{ gap: 8 }} aria-label={t.visits.coupons}>
      <h2 className="small">{t.visits.coupons}</h2>
      <ErrorBox>{error}</ErrorBox>
      {a.coupons.length > 0 ? (
        <div className="summary">
          {a.coupons.map((c) => (
            <span key={c.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                {t.visits.couponUsed}: {c.name} · −{money(c.discountGrosze)}
              </span>
              {open ? (
                <button
                  type="button"
                  className="link-btn small"
                  disabled={busy}
                  onClick={() => void change(`${url}/${c.id}/remove`)}
                >
                  {t.visits.couponRemove}
                </button>
              ) : null}
            </span>
          ))}
          <span className="big">
            {t.visits.toPay}: {money(a.service.priceGrosze - a.discountGrosze)}
          </span>
        </div>
      ) : null}
      {offered.length > 0 ? (
        <>
          <p className="small muted">{t.visits.couponsHint}</p>
          <ul className="history">
            {offered.map((c) => (
              <li key={c.id}>
                <span>
                  {c.name}
                  {c.problem ? (
                    <span className="muted small"> · {t.visits.couponProblem[c.problem]}</span>
                  ) : null}
                </span>
                {c.problem ? null : (
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy}
                    onClick={() => void change(url, { couponId: c.id })}
                  >
                    {t.visits.couponUse}
                    {c.discountGrosze !== null ? ` −${money(c.discountGrosze)}` : ''}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
