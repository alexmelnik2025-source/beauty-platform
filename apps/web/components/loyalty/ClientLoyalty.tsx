'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ErrorBox, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import type { LoyaltyAccount, LoyaltyProgram, LoyaltyReward } from '@/lib/types';
import { costLabel } from './RewardSheet';

/**
 * "Bonusy" in the client card (owners and managers): balance, exchange for a reward → coupon,
 * cancelling an unused coupon, a manual change with a reason, and the client's history.
 * How much a visit earns is decided by the server ("Paid" in the visit card).
 */
export function ClientLoyalty({ orgId, customerId }: { orgId: string; customerId: string }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const org = `/v1/organizations/${orgId}`;
  const [account, setAccount] = useState<LoyaltyAccount | null>(null);
  const [program, setProgram] = useState<LoyaltyProgram | null>(null);
  const [rewards, setRewards] = useState<LoyaltyReward[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [adjust, setAdjust] = useState({ points: '', reason: '' });

  const load = useCallback(async () => {
    const [a, p, r] = await Promise.all([
      api<LoyaltyAccount>(`${org}/loyalty/accounts/${customerId}`),
      api<LoyaltyProgram>(`${org}/loyalty/program`),
      api<LoyaltyReward[]>(`${org}/loyalty/rewards`),
    ]);
    setAccount(a);
    setProgram(p);
    setRewards(r);
  }, [org, customerId]);

  useEffect(() => {
    load().catch((err) => setError(errorText(t, err)));
  }, [load, t]);

  async function run(action: () => Promise<string | void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const done = await action();
      await load();
      if (done) setMessage(done);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  if (!account || !program) {
    return (
      <section className="section">
        <h3>{t.loyalty.clientTitle}</h3>
        {error ? <ErrorBox>{error}</ErrorBox> : <Spinner />}
      </section>
    );
  }

  const stamps = account.mode === 'stamps';
  const date = (iso: string) =>
    new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric' }).format(
      new Date(iso),
    );

  function saveAdjust(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api(`${org}/loyalty/accounts/${customerId}/adjustments`, {
        method: 'POST',
        body: { points: Number(adjust.points), reason: adjust.reason },
      });
      setAdjust({ points: '', reason: '' });
      return t.actions.saved;
    });
  }

  return (
    <section className="section" aria-labelledby={`bonus-${customerId}`}>
      <h3 id={`bonus-${customerId}`}>{t.loyalty.clientTitle}</h3>
      <ErrorBox>{error}</ErrorBox>
      {message ? (
        <p className="note" role="status">
          {message}
        </p>
      ) : null}
      {!program.enabled ? (
        <p className="small muted">
          <Link href={`/${locale}/app/loyalty`}>{t.loyalty.programOff}</Link>
        </p>
      ) : null}
      <div>
        <strong>
          {fill(stamps ? t.loyalty.balanceStamps : t.loyalty.balancePoints, {
            count: String(account.balance),
          })}
        </strong>
        <div className="small muted">
          {fill(t.loyalty.lifetime, { count: String(account.lifetimeEarned) })}
        </div>
      </div>

      {program.enabled && rewards.length ? (
        <div className="stack" style={{ gap: 8 }}>
          <h4>{t.loyalty.redeemTitle}</h4>
          {stamps ? <p className="small muted">{t.loyalty.redeemStampsHint}</p> : null}
          <ul className="history">
            {rewards.map((r) => (
              <li key={r.id}>
                <span>
                  {r.name} <span className="muted">· {costLabel(t, account.mode, r.cost)}</span>
                </span>
                <button
                  type="button"
                  className="btn btn--small btn--quiet"
                  aria-label={`${t.loyalty.redeem}: ${r.name}`}
                  disabled={busy || account.balance < r.cost}
                  onClick={() =>
                    void run(async () => {
                      const coupon = await api<{ code: string }>(
                        `${org}/loyalty/accounts/${customerId}/redemptions`,
                        { method: 'POST', body: { rewardId: r.id } },
                      );
                      return fill(t.loyalty.redeemed, { code: coupon.code });
                    })
                  }
                >
                  {t.loyalty.redeem}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="stack" style={{ gap: 8 }}>
        <h4>{t.loyalty.coupons}</h4>
        {account.coupons.length === 0 ? (
          <p className="small muted">{t.loyalty.noCoupons}</p>
        ) : (
          <ul className="history" aria-label={t.loyalty.coupons}>
            {account.coupons.map((c) => (
              <li key={c.id}>
                <span>
                  <strong>{c.code}</strong> · {c.name}
                  <span className="muted" style={{ display: 'block' }}>
                    {t.loyalty[`coupon_${c.status}`]}
                    {c.status === 'active' && c.expiresAt
                      ? ` · ${fill(t.loyalty.validUntil, { date: date(c.expiresAt) })}`
                      : ''}
                  </span>
                </span>
                {c.status === 'active' ? (
                  <button
                    type="button"
                    className="link-btn small"
                    aria-label={`${t.loyalty.cancelCoupon} ${c.code}`}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api(`${org}/loyalty/coupons/${c.id}/cancel`, {
                          method: 'POST',
                          body: { version: c.version },
                        });
                      })
                    }
                  >
                    {t.loyalty.cancelCoupon}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <form className="form" onSubmit={saveAdjust} aria-label={t.loyalty.adjustTitle}>
        <h4>{t.loyalty.adjustTitle}</h4>
        <div className="row">
          <label className="field" style={{ flex: '0 1 140px' }}>
            <span>{t.loyalty.adjustPoints}</span>
            <input
              type="number"
              required
              min={-100000}
              max={100000}
              value={adjust.points}
              onChange={(e) => setAdjust({ ...adjust, points: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t.loyalty.adjustReason}</span>
            <input
              required
              minLength={3}
              maxLength={500}
              value={adjust.reason}
              onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })}
            />
          </label>
        </div>
        <button
          className="btn btn--quiet"
          disabled={busy || adjust.points.trim() === '' || Number(adjust.points) === 0}
        >
          {t.loyalty.adjust}
        </button>
      </form>

      {account.transactions.length ? (
        <div className="stack" style={{ gap: 8 }}>
          <h4>{t.loyalty.clientHistory}</h4>
          <ul className="history">
            {account.transactions.map((h) => (
              <li key={h.id}>
                <span>
                  {t.loyalty[`type_${h.type}`]}
                  {h.note ? <span className="muted"> — {h.note}</span> : null}
                  <span className="muted" style={{ display: 'block' }}>
                    {date(h.createdAt)}
                  </span>
                </span>
                <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <strong>{h.points > 0 ? `+${h.points}` : h.points}</strong>
                  <span className="muted" style={{ display: 'block' }}>
                    {fill(t.loyalty.balanceAfter, { count: String(h.balanceAfter) })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
