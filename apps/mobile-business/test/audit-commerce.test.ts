import { expect, it } from 'vitest';
import { rewardToSave, EMPTY_REWARD_FULL } from '../src/rewardEdit';

const discount = { ...EMPTY_REWARD_FULL, name: 'Welcome', percent: ' 25 % ', cost: '05' };

it.each([
  ['percent', '1e2'],
  ['percent', '0x10%'],
  ['cost', '1e5'],
  ['cost', '0b101'],
] as const)('rejects %s entered as %s in the reward editor', (field, value) => {
  expect(rewardToSave({ ...discount, [field]: value })).toEqual({ ok: false, problem: field });
});

it('keeps human-entered percentage signs, surrounding spaces and leading zeros', () => {
  expect(rewardToSave(discount)).toMatchObject({
    ok: true,
    reward: { discountPercent: 25, cost: 5 },
  });
});
