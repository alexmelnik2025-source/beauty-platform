/** Outbox types (rendered by OutboxService.renderWaitlist). */
export const WAITLIST_JOINED = 'waitlist_joined';
export const WAITLIST_FREE = 'waitlist_free';

export interface WaitlistNotification {
  entryId: string;
  /** waitlist_free: the first free start times, "14:30" in the salon's time zone. */
  times?: string[];
}
