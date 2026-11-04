import type { Service, StaffService } from '../generated/prisma/client';

/**
 * Task 70: a specialist may have their own price and duration of a service.
 * Null on the link means "as the service says".
 */
export interface StaffOffer {
  staffId: string;
  priceGrosze: number;
  durationMinutes: number;
}

export function offerOf(
  service: Pick<Service, 'priceGrosze' | 'durationMinutes'>,
  link: Pick<StaffService, 'staffId' | 'priceGrosze' | 'durationMinutes'>,
): StaffOffer {
  return {
    staffId: link.staffId,
    priceGrosze: link.priceGrosze ?? service.priceGrosze,
    durationMinutes: link.durationMinutes ?? service.durationMinutes,
  };
}

/** "a,b,c" in a query string → unique ids (the zod schema checks they are uuids). */
export function splitIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}
