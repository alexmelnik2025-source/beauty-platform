/** Outbox types (rendered by OutboxService.renderWaitlist). */
export const WAITLIST_JOINED = 'waitlist_joined';
export const WAITLIST_FREE = 'waitlist_free';
/** Task 164: a time is held for the first client in the queue for 15 minutes. */
export const WAITLIST_OFFER = 'waitlist_offer';

export interface WaitlistNotification {
  entryId: string;
  /** waitlist_free: the first free start times, "14:30" in the salon's time zone. */
  times?: string[];
  /** waitlist_offer: the held time, "14:30" in the salon's time zone. */
  time?: string;
}
