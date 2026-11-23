'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { ErrorBox, FieldError, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
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
  const currency = useSession().location.currency;
  const org = `/v1/organizations/${orgId}`;
  const [account, setAccount] = useState<LoyaltyAccount | null>(null);
  const [program, setProgram] = useState<LoyaltyProgram | null>(null);
  const [rewards, setRewards] = useState<LoyaltyReward[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [adjust, setAdjust] = useState({ points: '', reason: '' });
  /**
   * Task 692 (owner's rule: errors at the field): a missing, zero or too big number and a too
   * short reason are said under their field instead of a silent button or the browser's bubble.
   */
  const [adjustProblems, setAdjustProblems] = useState<
    Partial<Record<'points' | 'reason', string>>
  >({});

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

  function saveAdjust(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const points = Number(adjust.points);
    const found: Partial<Record<'points' | 'reason', string>> = {};
    if (!adjust.points.trim()) found.points = t.onboarding.fieldRequired;
    else if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 100000) {
      found.points = t.loyalty.adjustPointsInvalid;
    }
    if (!adjust.reason.trim()) found.reason = t.onboarding.fieldRequired;
    else if (adjust.reason.trim().length < 3) found.reason = t.loyalty.adjustReasonShort;
    setAdjustProblems(found);
    const first = (['points', 'reason'] as const).find((field) => found[field]);
    if (first) {
      e.currentTarget.querySelector<HTMLInputElement>(`input[name="${first}"]`)?.focus();
      return;
    }
    void run(async () => {
      await api(`${org}/loyalty/accounts/${customerId}/adjustments`, {
        method: 'POST',
        body: { points, reason: adjust.reason.trim() },
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
      {account.tier ? (
        <div>
          <span className="chip">
            {account.tier.current
              ? fill(t.loyalty.tierCurrent, { name: account.tier.current.name }) +
                (account.tier.current.discountPercent
                  ? ` · −${account.tier.current.discountPercent}%`
                  : '')
              : t.loyalty.tierBelow}
          </span>{' '}
          <span className="small muted">
            {account.tier.next
              ? account.tier.basis === 'visits'
                ? fill(t.loyalty.tierNextVisits, {
                    name: account.tier.next.name,
                    count: String(account.tier.next.missing),
                  })
                : fill(t.loyalty.tierNextSpend, {
                    name: account.tier.next.name,
                    amount: formatPrice(account.tier.next.missing, currency, tag),
                  })
              : t.loyalty.tierTop}
          </span>
        </div>
      ) : null}

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

      <form noValidate className="form" onSubmit={saveAdjust} aria-label={t.loyalty.adjustTitle}>
        <h4>{t.loyalty.adjustTitle}</h4>
        <div className="row">
          <label className="field" style={{ flex: '0 1 140px' }}>
            <span>{t.loyalty.adjustPoints}</span>
            <input
              type="number"
              required
              min={-100000}
              max={100000}
              name="points"
              value={adjust.points}
              aria-invalid={adjustProblems.points ? true : undefined}
              aria-describedby={
                adjustProblems.points ? `adjust-points-error-${customerId}` : undefined
              }
              onChange={(e) => {
                setAdjust({ ...adjust, points: e.target.value });
                setAdjustProblems({ ...adjustProblems, points: undefined });
              }}
            />
            <FieldError id={`adjust-points-error-${customerId}`} text={adjustProblems.points} />
          </label>
          <label className="field">
            <span>{t.loyalty.adjustReason}</span>
            <input
              required
              minLength={3}
              maxLength={500}
              name="reason"
              value={adjust.reason}
              aria-invalid={adjustProblems.reason ? true : undefined}
              aria-describedby={
                adjustProblems.reason ? `adjust-reason-error-${customerId}` : undefined
              }
              onChange={(e) => {
                setAdjust({ ...adjust, reason: e.target.value });
                setAdjustProblems({ ...adjustProblems, reason: undefined });
              }}
            />
            <FieldError id={`adjust-reason-error-${customerId}`} text={adjustProblems.reason} />
          </label>
        </div>
        <button className="btn btn--quiet" disabled={busy}>
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
