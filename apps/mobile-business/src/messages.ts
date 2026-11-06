import type { Location } from './api';

/**
 * "Wiadomości do klientów" in the business app (task 208; in the cabinet — "Ustawienia", tasks
 * 22, 164, 165c): the reminder e-mail before a visit, how long a freed time waits for the first
 * person on the waiting list, and "Pora na kolejną wizytę" with its own words. No React Native
 * here — tested in Vitest (test/messages.test.ts). The server checks the same limits again.
 */

/** Hours before the visit the reminder goes (0 = none) — the server allows only these. */
export const REMINDER_HOURS = [0, 2, 3, 6, 12, 24, 48] as const;
/** Minutes a freed time is held for the first person on the waiting list (0 = everyone at once). */
export const HOLD_MINUTES = [0, 10, 15, 30, 60] as const;

export interface MessagesForm {
  reminderHoursBefore: number;
  waitlistHoldMinutes: number;
  rebookOn: boolean;
  /** Typed by the person: 7–365. */
  rebookDays: string;
  rebookText: string;
}

export interface MessagesChanges {
  reminderHoursBefore?: number;
  waitlistHoldMinutes?: number;
  rebookReminderDays?: number;
  rebookReminderText?: string | null;
}

export type MessagesProblem = 'rebookDays' | 'rebookText';

/** What the form starts with: the salon as the server has it. */
export function messagesForm(location: Location): MessagesForm {
  return {
    reminderHoursBefore: location.reminderHoursBefore,
    waitlistHoldMinutes: location.waitlistHoldMinutes,
    rebookOn: location.rebookReminderDays > 0,
    rebookDays: location.rebookReminderDays > 0 ? String(location.rebookReminderDays) : '',
    rebookText: location.rebookReminderText ?? '',
  };
}

/**
 * Only what changed. "Pora na kolejną wizytę" switched off sends 0 days (the words stay for
 * later); switched on it needs 7–365 days. An empty text means the platform's own words.
 */
export function messagesChanges(
  location: Location,
  form: MessagesForm,
): { changes: MessagesChanges } | { problem: MessagesProblem } {
  let days = 0;
  if (form.rebookOn) {
    const typed = form.rebookDays.trim();
    days = Number(typed);
    if (!/^\d+$/.test(typed) || days < 7 || days > 365) return { problem: 'rebookDays' };
  }
  const text = form.rebookText.trim();
  if (text.length > 500) return { problem: 'rebookText' };

  const changes: MessagesChanges = {};
  if (form.reminderHoursBefore !== location.reminderHoursBefore) {
    changes.reminderHoursBefore = form.reminderHoursBefore;
  }
  if (form.waitlistHoldMinutes !== location.waitlistHoldMinutes) {
    changes.waitlistHoldMinutes = form.waitlistHoldMinutes;
  }
  if (days !== location.rebookReminderDays) changes.rebookReminderDays = days;
  if ((text || null) !== location.rebookReminderText) changes.rebookReminderText = text || null;
  return { changes };
}
