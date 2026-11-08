import type { LoyaltyProgram } from './api';

/**
 * Task 347: "Pieczątki i punkty za usługi" in the business app (in the cabinet — the
 * "Pieczątki i punkty za usługi" form of the loyalty page): a service of this salon can give its
 * own number instead of the general rule (an empty field = the general rule, 0 = the service gives
 * nothing). Saved as the whole list of this salon. Tested in Vitest (test/earnRules.test.ts).
 */

export interface EarnService {
  id: string;
  name: string;
}

/** Service id → the number as typed ('' = the general rule). */
export type EarnRows = Record<string, string>;

export interface EarnRulesSave {
  rules: { serviceId: string; points: number }[];
}

/** The server's limit for one service. */
export const MAX_EARN = 100_000;

/** The rules of this salon as typed numbers. */
export function earnRows(program: Pick<LoyaltyProgram, 'earnRules'>, locationId: string): EarnRows {
  return Object.fromEntries(
    program.earnRules
      .filter((r) => r.locationId === locationId)
      .map((r) => [r.serviceId, String(r.points)]),
  );
}

/**
 * The services to show: the active ones, plus any service of this salon that already has its own
 * number (e.g. switched off later) so that saving never drops it unseen.
 */
export function earnServices(
  program: Pick<LoyaltyProgram, 'earnRules'>,
  locationId: string,
  active: EarnService[],
): EarnService[] {
  const list = [...active];
  for (const r of program.earnRules) {
    if (r.locationId === locationId && !list.some((s) => s.id === r.serviceId)) {
      list.push({ id: r.serviceId, name: r.serviceName });
    }
  }
  return list;
}

/** Checks the rows; returns the list for `PUT …/loyalty/earn-rules` or the service to fix. */
export function earnToSave(
  rows: EarnRows,
  services: EarnService[],
): { ok: true; save: EarnRulesSave } | { ok: false; service: string } {
  const rules: EarnRulesSave['rules'] = [];
  for (const [serviceId, typed] of Object.entries(rows)) {
    const value = typed.replace(/\s/g, '');
    if (value === '') continue;
    if (!/^\d{1,6}$/.test(value) || Number(value) > MAX_EARN) {
      return { ok: false, service: services.find((s) => s.id === serviceId)?.name ?? '' };
    }
    rules.push({ serviceId, points: Number(value) });
  }
  return { ok: true, save: { rules } };
}

/** The services with their own number, in the order of the list ("Strzyżenie · 2"). */
export function earnSummary(
  program: Pick<LoyaltyProgram, 'earnRules'>,
  locationId: string,
  services: EarnService[],
): { name: string; points: number }[] {
  const own = new Map(
    program.earnRules.filter((r) => r.locationId === locationId).map((r) => [r.serviceId, r]),
  );
  return services
    .filter((s) => own.has(s.id))
    .map((s) => ({ name: s.name, points: own.get(s.id)!.points }));
}
