'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import type { Dict } from '@/lib/i18n/pl';
import { formatPrice } from '@/lib/time';
import type { ClientLoyalty, ClientLoyaltyCard } from '@/lib/types';
import { ErrorBox, Spinner } from '../ui';

type Reward = ClientLoyaltyCard['rewards'][number];
type Coupon = ClientLoyaltyCard['coupons'][number];

/** Stamp cards longer than this are shown as a bar instead of single stamps. */
const MAX_STAMPS_DRAWN = 12;

function rewardText(t: Dict, r: Pick<Reward, 'kind' | 'discountPercent' | 'freeServiceName'>) {
  return r.kind === 'discount_percent'
    ? fill(t.loyalty.discountLabel, { percent: String(r.discountPercent ?? 0) })
    : fill(t.loyalty.freeLabel, { service: r.freeServiceName ?? '' });
}

/** "Moje bonusy": stamps or points in every salon, rewards, coupons and history. */
export function ClientBonuses({ onSignedOut }: { onSignedOut: () => void }) {
  const { t } = useI18n();
  const [items, setItems] = useState<ClientLoyaltyCard[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<ClientLoyalty>('/v1/client/loyalty', { auth: false })
      .then((res) => setItems(res.items))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) onSignedOut();
        else setError(errorText(t, err));
      });
  }, [t, onSignedOut]);

  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (items === null) return <Spinner />;
  if (items.length === 0) return <p className="note">{t.bonuses.empty}</p>;
  return (
    <div className="stack">
      {items.map((card) => (
        <BonusCard key={card.organization.id} card={card} />
      ))}
    </div>
  );
}

function BonusCard({ card }: { card: ClientLoyaltyCard }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const stamps = card.mode === 'stamps';
  const date = (iso: string) =>
    new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric' }).format(
      new Date(iso),
    );
  const next = card.next ? card.rewards.find((r) => r.id === card.next?.rewardId) : undefined;
  // The best reward the client can already take (rewards come cheapest first).
  const ready = [...card.rewards].reverse().find((r) => r.missing === 0);
  const headingId = `bonus-${card.organization.id}`;

  let progress: string | null = null;
  if (next && card.next) {
    progress =
      card.next.visits !== null
        ? fill(t.bonuses.nextVisits, { count: String(card.next.visits), reward: next.name })
        : fill(stamps ? t.bonuses.nextStamps : t.bonuses.nextPoints, {
            count: String(card.next.missing),
            reward: next.name,
          });
  }

  return (
    <section className="bonus-card" aria-labelledby={headingId}>
      <div className="bonus-head">
        <h2 id={headingId}>{card.organization.name}</h2>
        {card.bookingSlug ? (
          <Link className="btn btn--quiet btn--small" href={`/${locale}/b/${card.bookingSlug}`}>
            {t.bonuses.book}
          </Link>
        ) : null}
      </div>
      {!card.enabled ? <p className="small muted">{t.bonuses.programOff}</p> : null}

      {card.enabled ? (
        <>
          <p className="bonus-balance">
            <strong>
              {fill(stamps ? t.loyalty.balanceStamps : t.loyalty.balancePoints, {
                count: String(card.balance),
              })}
            </strong>
          </p>
          <Progress card={card} />
          {ready ? (
            <p className="note" role="status">
              {fill(stamps ? t.bonuses.readyStamps : t.bonuses.readyPoints, {
                count: String(card.balance),
                reward: ready.name,
              })}{' '}
              {t.bonuses.askSalon}
            </p>
          ) : null}
          {progress ? <p>{progress}</p> : null}
          <p className="small muted">
            {stamps
              ? fill(t.bonuses.earnStamps, { count: String(card.earning.stampsPerVisit) })
              : fill(t.bonuses.earnPoints, {
                  count: String(card.earning.pointsPerUnit),
                  amount: formatPrice(card.earning.spendUnitGrosze, tag),
                })}
            {card.earning.minSpendGrosze > 0
              ? ` · ${fill(t.bonuses.minSpend, { amount: formatPrice(card.earning.minSpendGrosze, tag) })}`
              : ''}
            {!stamps && card.earning.pointsValidityDays
              ? ` · ${fill(t.bonuses.validity, { days: String(card.earning.pointsValidityDays) })}`
              : ''}
          </p>

          {card.rewards.length ? (
            <div className="stack" style={{ gap: 8 }}>
              <h3>{t.bonuses.rewards}</h3>
              <ul
                className="history"
                aria-label={`${t.bonuses.rewards}: ${card.organization.name}`}
              >
                {card.rewards.map((r) => (
                  <li key={r.id}>
                    <span>
                      <strong>{r.name}</strong>
                      <span className="muted" style={{ display: 'block' }}>
                        {rewardText(t, r)} ·{' '}
                        {fill(stamps ? t.loyalty.stampsCount : t.loyalty.pointsCount, {
                          count: String(r.cost),
                        })}
                        {r.serviceNames.length
                          ? ` · ${fill(t.bonuses.onlyFor, { services: r.serviceNames.join(', ') })}`
                          : ''}
                      </span>
                    </span>
                    <span className={r.missing === 0 ? 'chip chip--ready' : 'chip'}>
                      {r.missing === 0
                        ? t.bonuses.available
                        : fill(t.bonuses.left, { count: String(r.missing) })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      <Coupons coupons={card.coupons} date={date} />

      {card.history.length ? (
        <details className="bonus-history">
          <summary>{t.bonuses.history}</summary>
          <ul className="history">
            {card.history.map((h) => (
              <li key={h.id}>
                <span>
                  {t.loyalty[`type_${h.type}`]}
                  {h.serviceName ? ` · ${h.serviceName}` : ''}
                  <span className="muted" style={{ display: 'block' }}>
                    {date(h.createdAt)}
                    {h.expiresAt && h.points > 0
                      ? ` · ${fill(t.loyalty.validUntil, { date: date(h.expiresAt) })}`
                      : ''}
                  </span>
                </span>
                <strong>{h.points > 0 ? `+${h.points}` : h.points}</strong>
              </li>
            ))}
          </ul>
          <p className="small muted">
            {fill(t.loyalty.lifetime, { count: String(card.lifetimeEarned) })}
          </p>
        </details>
      ) : null}
    </section>
  );
}

/** A stamp card (a circle per stamp, rewards marked) or a bar to the next reward. */
function Progress({ card }: { card: ClientLoyaltyCard }) {
  const { t } = useI18n();
  const top = card.rewards.at(-1)?.cost ?? 0;
  if (top === 0) return null;
  const label = fill(t.bonuses.progressLabel, {
    count: String(Math.min(card.balance, top)),
    total: String(top),
  });
  if (card.mode === 'stamps' && top <= MAX_STAMPS_DRAWN) {
    const marks = new Set(card.rewards.map((r) => r.cost));
    return (
      <ol className="stamps" aria-label={label}>
        {Array.from({ length: top }, (_, i) => (
          <li
            key={i}
            className={[
              'stamp',
              i < card.balance ? 'stamp--on' : '',
              marks.has(i + 1) ? 'stamp--reward' : '',
            ].join(' ')}
          >
            {marks.has(i + 1) ? '★' : i + 1}
          </li>
        ))}
      </ol>
    );
  }
  const goal = card.next
    ? (card.rewards.find((r) => r.id === card.next?.rewardId)?.cost ?? top)
    : top;
  return (
    <div
      className="bonus-bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={goal}
      aria-valuenow={Math.min(card.balance, goal)}
    >
      <span style={{ width: `${Math.min(100, (card.balance / goal) * 100)}%` }} />
    </div>
  );
}

function Coupons({ coupons, date }: { coupons: Coupon[]; date: (iso: string) => string }) {
  const { t } = useI18n();
  if (coupons.length === 0) return null;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <h3>{t.bonuses.coupons}</h3>
      <p className="small muted">{t.bonuses.couponHint}</p>
      <ul className="history" aria-label={t.bonuses.coupons}>
        {coupons.map((c) => (
          <li key={c.id} className={c.status === 'active' ? '' : 'muted'}>
            <span>
              <strong className="coupon-code">{c.code}</strong> · {c.name}
              <span className="muted" style={{ display: 'block' }}>
                {rewardText(t, c)}
                {c.serviceNames.length
                  ? ` · ${fill(t.bonuses.onlyFor, { services: c.serviceNames.join(', ') })}`
                  : ''}
              </span>
            </span>
            <span className="small" style={{ textAlign: 'right' }}>
              {t.loyalty[`coupon_${c.status}`]}
              {c.status === 'active' && c.expiresAt ? (
                <span className="muted" style={{ display: 'block' }}>
                  {fill(t.loyalty.validUntil, { date: date(c.expiresAt) })}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
