'use client';

import { useState, type FormEvent } from 'react';
import { ErrorBox, FieldError, Sheet } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
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

/** Task 668: the reward's fields that can show an error under them. */
type RewardField =
  'name' | 'discountPercent' | 'freeServiceId' | 'cost' | 'serviceIds' | 'couponValidityDays';
const REWARD_FIELDS: RewardField[] = [
  'name',
  'discountPercent',
  'freeServiceId',
  'cost',
  'serviceIds',
  'couponValidityDays',
];

/** The allowed range of each number (the server checks the same). */
const RANGES: Partial<Record<RewardField, [number, number]>> = {
  discountPercent: [1, 100],
  cost: [1, 100_000],
  couponValidityDays: [1, 3650],
};

/** The fields the server's validation answer is about; empty when it is about something else. */
function rewardFieldsOf(err: unknown): RewardField[] {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return [];
  if (!Array.isArray(err.details)) return [];
  const paths = (err.details as { path?: string }[]).map((d) => String(d.path ?? ''));
  return REWARD_FIELDS.filter((f) => paths.some((p) => p === f || p.startsWith(`${f}.`)));
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
  /**
   * Task 668 (owner's rule: errors at the field): a name of only spaces before sending, and the
   * server's answer about a field, are said under that field; editing it takes the error away.
   */
  const [problems, setProblems] = useState<RewardField[]>([]);
  const [busy, setBusy] = useState(false);
  const discount = form.kind === 'discount_percent';

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('');
      setProblems(['name']);
      return;
    }
    setBusy(true);
    setError('');
    setProblems([]);
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
      const fields = rewardFieldsOf(err);
      setProblems(fields);
      if (fields.length === 0) setError(errorText(t, err));
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

  /** Editing a field takes its error away. */
  const edit = (field: RewardField, change: Partial<typeof form>) => {
    setForm({ ...form, ...change });
    if (problems.includes(field)) setProblems(problems.filter((f) => f !== field));
  };
  const toggleService = (id: string, on: boolean) =>
    edit('serviceIds', {
      serviceIds: on ? [...form.serviceIds, id] : form.serviceIds.filter((s) => s !== id),
    });
  const problem = (field: RewardField): string | undefined => {
    if (!problems.includes(field)) return undefined;
    if (field === 'name') return t.onboarding.fieldRequired;
    const range = RANGES[field];
    if (!range) return t.errors.VALIDATION_ERROR;
    return fill(t.guard.numberRange, { min: String(range[0]), max: String(range[1]) });
  };
  const invalid = (field: RewardField) => ({
    'aria-invalid': problems.includes(field) || undefined,
    'aria-describedby': problems.includes(field) ? `reward-${field}-error` : undefined,
  });
  const fieldError = (field: RewardField) => (
    <FieldError id={`reward-${field}-error`} text={problem(field)} />
  );

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
            {...invalid('name')}
            onChange={(e) => edit('name', { name: e.target.value })}
          />
          {fieldError('name')}
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
                {...invalid('discountPercent')}
                onChange={(e) =>
                  edit('discountPercent', { discountPercent: Number(e.target.value) })
                }
              />
              {fieldError('discountPercent')}
            </label>
          ) : (
            <label className="field">
              <span>{t.loyalty.service}</span>
              <select
                required
                value={form.freeServiceId}
                {...invalid('freeServiceId')}
                onChange={(e) => edit('freeServiceId', { freeServiceId: e.target.value })}
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
              {fieldError('freeServiceId')}
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
              {...invalid('cost')}
              onChange={(e) => edit('cost', { cost: Number(e.target.value) })}
            />
            {fieldError('cost')}
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
          {fieldError('serviceIds')}
        </fieldset>
        <label className="field">
          <span>{t.loyalty.couponValidity}</span>
          <input
            type="number"
            min={1}
            max={3650}
            value={form.couponValidityDays}
            {...invalid('couponValidityDays')}
            onChange={(e) => edit('couponValidityDays', { couponValidityDays: e.target.value })}
          />
          {fieldError('couponValidityDays')}
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
