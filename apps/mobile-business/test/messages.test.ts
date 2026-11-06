import { describe, expect, it } from 'vitest';
import type { Location } from '../src/api';
import { messagesChanges, messagesForm } from '../src/messages';

const salon = (over: Partial<Location> = {}) =>
  ({
    id: 'loc-1',
    name: 'Gestalt Barbershop',
    timezone: 'Europe/Warsaw',
    reminderHoursBefore: 24,
    waitlistHoldMinutes: 0,
    rebookReminderDays: 0,
    rebookReminderText: null,
    version: 3,
    ...over,
  }) as Location;

describe('messagesForm', () => {
  it('starts with the salon as saved; "next visit" off has no days', () => {
    expect(messagesForm(salon())).toEqual({
      reminderHoursBefore: 24,
      waitlistHoldMinutes: 0,
      rebookOn: false,
      rebookDays: '',
      rebookText: '',
    });
    expect(
      messagesForm(salon({ rebookReminderDays: 35, rebookReminderText: 'Wpadnij!' })),
    ).toMatchObject({ rebookOn: true, rebookDays: '35', rebookText: 'Wpadnij!' });
  });
});

describe('messagesChanges', () => {
  it('sends nothing when nothing changed', () => {
    expect(messagesChanges(salon(), messagesForm(salon()))).toEqual({ changes: {} });
  });

  it('sends only what changed', () => {
    const form = {
      ...messagesForm(salon()),
      reminderHoursBefore: 2,
      waitlistHoldMinutes: 15,
      rebookOn: true,
      rebookDays: ' 30 ',
      rebookText: ' Dawno Cię nie było! ',
    };
    expect(messagesChanges(salon(), form)).toEqual({
      changes: {
        reminderHoursBefore: 2,
        waitlistHoldMinutes: 15,
        rebookReminderDays: 30,
        rebookReminderText: 'Dawno Cię nie było!',
      },
    });
  });

  it('switching "next visit" off sends 0 days; an empty text = the platform’s words', () => {
    const saved = salon({ rebookReminderDays: 30, rebookReminderText: 'Stary tekst' });
    expect(
      messagesChanges(saved, { ...messagesForm(saved), rebookOn: false, rebookText: '' }),
    ).toEqual({ changes: { rebookReminderDays: 0, rebookReminderText: null } });
  });

  it('days must be 7–365 when it is on, the text up to 500 characters', () => {
    const form = { ...messagesForm(salon()), rebookOn: true };
    expect(messagesChanges(salon(), { ...form, rebookDays: '' })).toEqual({
      problem: 'rebookDays',
    });
    expect(messagesChanges(salon(), { ...form, rebookDays: '6' })).toEqual({
      problem: 'rebookDays',
    });
    expect(messagesChanges(salon(), { ...form, rebookDays: '366' })).toEqual({
      problem: 'rebookDays',
    });
    expect(messagesChanges(salon(), { ...form, rebookDays: '3.5' })).toEqual({
      problem: 'rebookDays',
    });
    expect(
      messagesChanges(salon(), { ...form, rebookDays: '7', rebookText: 'x'.repeat(501) }),
    ).toEqual({ problem: 'rebookText' });
  });
});
