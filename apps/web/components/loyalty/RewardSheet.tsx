'use client';

import { useState, type FormEvent } from 'react';
import { ErrorBox, Sheet } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';
import type { Dict } from '@/lib/i18n/pl';
import type { LoyaltyProgram, LoyaltyReward, Service } from '@/lib/types';

type Mode = LoyaltyProgram['mode'];

/** "pieczątki: 3" or "pkt: 40". */
export function costLabel(t: Dict, mode: Mode, count: number): string {
  return fill(mode === 'stamps' ? t.loyalty.stampsCount : t.loyalty.pointsCount, {
    count: String(count),
  });
}

/** "Zniżka 25%" or "Gratis: Strzyżenie męskie". */
export function rewardLabel(
  t: Dict,
  reward: Pick<LoyaltyReward, 'kind' | 'discountPercent' | 'freeServiceId'>,
  serviceName: (id: string) => string,
): string {
  return reward.kind === 'discount_percent'
    ? fill(t.loyalty.discountLabel, { percent: String(reward.discountPercent ?? 0) })
    : fill(t.loyalty.freeLabel, { service: serviceName(reward.freeServiceId ?? '') });
}

/**
 * Add or change a reward of the catalogue. Services come from the current location; a reward
 * may also name services of other locations — those are kept as they are.
 */
export function RewardSheet({
  org,
  mode,
  reward,
  services,
  onClose,
  onSaved,
}: {
  org: string;
  mode: Mode;
  reward: LoyaltyReward | null;
  services: Service[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    name: reward?.name ?? '',
    kind: reward?.kind ?? ('discount_percent' as LoyaltyReward['kind']),
    discountPercent: reward?.discountPercent ?? 25,
    freeServiceId: reward?.freeServiceId ?? services[0]?.id ?? '',
    cost: reward?.cost ?? (mode === 'stamps' ? 3 : 100),
    serviceIds: reward?.serviceIds ?? [],
    couponValidityDays: reward?.couponValidityDays ? String(reward.couponValidityDays) : '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const discount = form.kind === 'discount_percent';

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = {
      name: form.name,
      kind: form.kind,
      discountPercent: discount ? Number(form.discountPercent) : null,
      freeServiceId: discount ? null : form.freeServiceId || null,
      cost: Number(form.cost),
      serviceIds: form.serviceIds,
      couponValidityDays: form.couponValidityDays ? Number(form.couponValidityDays) : null,
      sortOrder: reward?.sortOrder ?? 0,
    };
    try {
      if (reward) {
        await api(`${org}/loyalty/rewards/${reward.id}`, {
          method: 'PUT',
          body: { ...body, version: reward.version },
        });
      } else {
        await api(`${org}/loyalty/rewards`, { method: 'POST', body });
      }
      onSaved();
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  }

  async function archive() {
    if (!reward) return;
    setBusy(true);
    setError('');
    try {
      await api(`${org}/loyalty/rewards/${reward.id}`, { method: 'DELETE' });
      onSaved();
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  }

  const toggleService = (id: string, on: boolean) =>
    setForm({
      ...form,
      serviceIds: on ? [...form.serviceIds, id] : form.serviceIds.filter((s) => s !== id),
    });

  return (
    <Sheet title={reward ? t.loyalty.editReward : t.loyalty.addReward} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <ErrorBox>{error}</ErrorBox>
        <label className="field">
          <span>{t.loyalty.rewardName}</span>
          <input
            required
            maxLength={80}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="field">
          <span>{t.loyalty.kind}</span>
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as LoyaltyReward['kind'] })}
          >
            <option value="discount_percent">{t.loyalty.discount}</option>
            <option value="free_service">{t.loyalty.freeService}</option>
          </select>
        </label>
        <div className="row">
          {discount ? (
            <label className="field">
              <span>{t.loyalty.percent}</span>
              <input
                type="number"
                min={1}
                max={100}
                required
                value={form.discountPercent}
                onChange={(e) => setForm({ ...form, discountPercent: Number(e.target.value) })}
              />
            </label>
          ) : (
            <label className="field">
              <span>{t.loyalty.service}</span>
              <select
                required
                value={form.freeServiceId}
                onChange={(e) => setForm({ ...form, freeServiceId: e.target.value })}
              >
                {form.freeServiceId && !services.some((s) => s.id === form.freeServiceId) ? (
                  <option value={form.freeServiceId}>{t.loyalty.otherService}</option>
                ) : null}
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>{mode === 'stamps' ? t.loyalty.costStamps : t.loyalty.costPoints}</span>
            <input
              type="number"
              min={1}
              max={100000}
              required
              value={form.cost}
              onChange={(e) => setForm({ ...form, cost: Number(e.target.value) })}
            />
          </label>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>{t.loyalty.onlyServices}</legend>
          <div className="list-pick">
            {services.map((s) => (
              <label key={s.id} className="check">
                <input
                  type="checkbox"
                  checked={form.serviceIds.includes(s.id)}
                  onChange={(e) => toggleService(s.id, e.target.checked)}
                />
                <span>{s.name}</span>
              </label>
            ))}
          </div>
          <span className="small muted">{t.loyalty.anyServiceHint}</span>
        </fieldset>
        <label className="field">
          <span>{t.loyalty.couponValidity}</span>
          <input
            type="number"
            min={1}
            max={3650}
            value={form.couponValidityDays}
            onChange={(e) => setForm({ ...form, couponValidityDays: e.target.value })}
          />
          <span className="small muted">{t.loyalty.noLimitHint}</span>
        </label>
        <button className="btn btn--block" disabled={busy}>
          {t.common.save}
        </button>
        {reward && !reward.archivedAt ? (
          <>
            <button
              type="button"
              className="btn btn--quiet btn--block"
              disabled={busy}
              onClick={() => void archive()}
            >
              {t.loyalty.archive}
            </button>
            <span className="small muted">{t.loyalty.archiveHint}</span>
          </>
        ) : null}
      </form>
    </Sheet>
  );
}
