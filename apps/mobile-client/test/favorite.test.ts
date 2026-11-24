import { describe, expect, it } from 'vitest';
import type { ClientAppointment } from '../src/api';
import { favoriteSpecialists } from '../src/favorite';

/** Task 165d: "your specialist" in each salon, from the visits that took place. */

const NOW = Date.parse('2026-11-05T12:00:00Z');

function visit(
  day: string,
  staff: string,
  status: ClientAppointment['status'] = 'completed',
  salon = 'gestalt',
  bookable = true,
): ClientAppointment {
  return {
    id: `${salon}-${day}-${staff}`,
    status,
    start: `${day}T10:00:00Z`,
    end: `${day}T10:45:00Z`,
    salon: { name: salon === 'gestalt' ? 'Gestalt Barbershop' : 'Moda', slug: salon },
    staff: { id: `id-${staff}`, displayName: staff },
    service: { id: `svc-${day}`, name: `Strzyżenie ${day}` },
    bookAgain: bookable ? { slug: salon, serviceId: `svc-${day}`, staffId: `id-${staff}` } : null,
  } as unknown as ClientAppointment;
}

describe('favoriteSpecialists', () => {
  it('the specialist with most visits; on a tie the latest; with their latest service', () => {
    const list = favoriteSpecialists(
      [
        visit('2026-10-01', 'Kasia'),
        visit('2026-10-20', 'Marek'),
        visit('2026-09-01', 'Kasia'),
        visit('2026-08-01', 'Marek', 'no_show'),
        visit('2026-10-30', 'Ola', 'cancelled'),
      ],
      3,
      NOW,
    );
    expect(list).toEqual([
      {
        slug: 'gestalt',
        salonName: 'Gestalt Barbershop',
        staffName: 'Kasia',
        serviceName: 'Strzyżenie 2026-10-01',
        visits: 2,
        preset: { serviceId: 'svc-2026-10-01', staffId: 'id-Kasia' },
      },
    ]);
    const tie = favoriteSpecialists(
      [visit('2026-10-01', 'Kasia'), visit('2026-10-20', 'Marek')],
      3,
      NOW,
    );
    expect(tie[0]!.staffName).toBe('Marek');
  });

  it('includes a confirmed visit from its end time and applies the salon limit', () => {
    const latest = visit('2026-11-05', 'Ola', 'confirmed', 'moda');
    const past = [visit('2026-11-01', 'Kasia'), latest];
    const end = Date.parse(latest.end);
    expect(favoriteSpecialists(past, 1, end - 1).map((f) => f.slug)).toEqual(['gestalt']);
    expect(favoriteSpecialists(past, 1, end).map((f) => f.slug)).toEqual(['moda']);
  });

  it('one per salon, the salon visited last first; only bookable visits that took place', () => {
    const list = favoriteSpecialists(
      [
        visit('2026-10-01', 'Kasia'),
        visit('2026-10-25', 'Emre', 'confirmed', 'moda'), // took place, nobody marked it
        visit('2026-11-20', 'Ola', 'confirmed'), // still ahead
        visit('2026-10-28', 'Tomek', 'completed', 'gone', false), // not online any more
      ],
      3,
      NOW,
    );
    expect(list.map((f) => `${f.salonName}: ${f.staffName}`)).toEqual([
      'Moda: Emre',
      'Gestalt Barbershop: Kasia',
    ]);
    expect(favoriteSpecialists([visit('2026-10-01', 'Kasia')], 0, NOW)).toEqual([]);
    expect(favoriteSpecialists([], 3, NOW)).toEqual([]);
  });
});
