import type { DayBlock } from './blocks';
import type { DayVisit } from './day';

/**
 * "Udostępnij plan dnia" in the business app (task 351): the day as plain text for the team chat
 * or to print from the phone — what the cabinet's "Drukuj plan dnia" (task 142) shows on paper.
 * Visits in time order with the specialist, service and client; the phone only when the server
 * showed it to this person (it sends null otherwise); who works and the blocked time. It is the
 * list on the screen, so "Tylko moje" gives only one's own visits. No React Native here — tested
 * in Vitest (test/dayPlan.test.ts).
 */

export interface DayPlanLabels {
  working: string;
  nobodyWorks: string;
  empty: string;
  blocks: string;
  wholeSalon: string;
  walkIn: string;
  awaitingApproval: string;
}

export function dayPlanText(
  plan: {
    salon: string;
    title: string;
    visits: DayVisit[];
    working: { name: string; hours: string }[];
    blocks: DayBlock[];
  },
  labels: DayPlanLabels,
): string {
  const lines = [`${plan.salon} — ${plan.title}`, ''];
  lines.push(
    plan.working.length === 0
      ? labels.nobodyWorks
      : `${labels.working}: ${plan.working.map((w) => `${w.name} ${w.hours}`).join(' · ')}`,
  );
  lines.push('');
  if (plan.visits.length === 0) lines.push(labels.empty);
  for (const v of plan.visits) {
    const client = [v.customer ?? labels.walkIn, v.phone].filter(Boolean).join(', ');
    const waiting = v.waiting ? ` (${labels.awaitingApproval})` : '';
    lines.push(`${v.start}–${v.end} · ${v.staff} · ${v.service} — ${client}${waiting}`);
  }
  if (plan.blocks.length > 0) {
    lines.push('', `${labels.blocks}:`);
    for (const b of plan.blocks) {
      const reason = b.reason ? ` — ${b.reason}` : '';
      lines.push(`${b.start}–${b.end} · ${b.staff ?? labels.wholeSalon}${reason}`);
    }
  }
  return lines.join('\n');
}
