import type { Prisma } from '../generated/prisma/client';

/**
 * Task 609: whether a visit counts as one that took place — for reviews, the "How was it?" email
 * and "Time for your next visit". A finished visit still "confirmed" counts, except one the salon
 * never approved (cancellation guard, `approvalRequestedAt` set): the client did not come, the
 * salon only never answered. Cancelled, no-show and expired visits never count.
 */
export function visitTookPlace(
  visit: { status: string; endAt: Date; approvalRequestedAt: Date | null },
  now: Date,
): boolean {
  if (visit.status === 'completed') return true;
  return (
    visit.status === 'confirmed' &&
    visit.approvalRequestedAt === null &&
    visit.endAt.getTime() <= now.getTime()
  );
}

/** Prisma filter for the visits `visitTookPlace` can accept (the time is checked separately). */
export const TOOK_PLACE_WHERE: Prisma.AppointmentWhereInput = {
  OR: [{ status: 'completed' }, { status: 'confirmed', approvalRequestedAt: null }],
};

/**
 * Task 609: reviews shown to clients and counted in public stars — only of visits that still
 * stand. A review written after the visit and followed by "no-show" or a cancellation in the
 * salon's calendar stays in the salon's own list, but leaves the public page and the averages.
 */
export const PUBLIC_REVIEW_WHERE: Prisma.VisitReviewWhereInput = {
  appointment: { status: { in: ['confirmed', 'completed'] } },
};
