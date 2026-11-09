'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fill, useI18n } from '@/lib/i18n';
import type { Location, Service, Staff, WorkingHours } from '@/lib/types';

const STEPS = ['services', 'team', 'hours', 'legal', 'online'] as const;
type Step = (typeof STEPS)[number];

/** Where each step is done in the cabinet. */
const PAGES: Record<Step, string> = {
  services: 'services',
  team: 'team',
  hours: 'team',
  legal: 'settings',
  online: 'settings',
};

/**
 * Task 353, "Pierwsze kroki" — the cabinet's twin of the business app's card (task 352): above
 * the calendar the owner or a manager sees what the salon still needs before clients can book it
 * online (a service, a specialist who does it, her weekly hours, the terms and privacy policy,
 * online booking on). Shown on an empty calendar view only (no visits), so a working day keeps
 * its space. Every open step links to its page. Read when shown; gone once everything is done,
 * and hidden when reading fails.
 */
export function SetupSteps({ base }: { base: string }) {
  const { t, locale } = useI18n();
  const s = t.firstSteps;
  const [steps, setSteps] = useState<{ step: Step; done: boolean }[] | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [location, services, staff] = await Promise.all([
        api<Location>(base),
        api<Service[]>(`${base}/services`),
        api<Staff[]>(`${base}/staff`),
      ]);
      const active = new Set(services.filter((x) => x.active).map((x) => x.id));
      const bookable = staff.filter((p) => p.active && p.serviceIds.some((id) => active.has(id)));
      let hours = false;
      for (const person of bookable) {
        const h = await api<WorkingHours>(`${base}/staff/${person.id}/working-hours`);
        if (h.weekly.some((d) => d.intervals.length > 0)) {
          hours = true;
          break;
        }
      }
      const done: Record<Step, boolean> = {
        services: active.size > 0,
        team: bookable.length > 0,
        hours,
        legal: !!location.bookingTerms?.trim() && !!location.privacyPolicy?.trim(),
        online: location.onlineBookingEnabled,
      };
      if (alive) setSteps(STEPS.map((step) => ({ step, done: done[step] })));
    })().catch(() => {
      if (alive) setSteps(null);
    });
    return () => {
      alive = false;
    };
  }, [base]);

  if (!steps || steps.every((x) => x.done)) return null;
  const left = steps.filter((x) => !x.done).length;
  return (
    <section className="setup-steps" aria-labelledby="setup-steps-title" data-testid="setup-steps">
      <h2 id="setup-steps-title">{s.title}</h2>
      <p className="muted">{fill(s.lead, { n: String(left) })}</p>
      <ol>
        {steps.map(({ step, done }) => (
          <li key={step} className={done ? 'is-done' : undefined}>
            <span>
              {done ? '✓ ' : ''}
              {s.steps[step]}
              <span className="visually-hidden"> — {done ? s.doneLabel : s.todoLabel}</span>
            </span>
            {!done ? (
              <Link
                href={`/${locale}/app/${PAGES[step]}`}
                className="btn btn--quiet btn--small"
                aria-label={`${s.go}: ${s.steps[step]}`}
              >
                {s.go}
              </Link>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
