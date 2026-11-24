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

  it('clears a whitespace-only reminder and keeps placeholders as typed in a custom message', () => {
    const saved = salon({ rebookReminderDays: 30, rebookReminderText: 'Stary tekst' });
    const form = messagesForm(saved);
    expect(messagesChanges(saved, { ...form, rebookText: '  \n  ' })).toEqual({
      changes: { rebookReminderText: null },
    });
    const template = 'Zapraszamy {name} do {salon}!';
    expect(messagesChanges(saved, { ...form, rebookText: template })).toEqual({
      changes: { rebookReminderText: template },
    });
  });

  it('accepts 500 characters after trimming and rejects a very long message', () => {
    const saved = salon({ rebookReminderDays: 30 });
    const form = messagesForm(saved);
    const limit = 'ó'.repeat(500);
    expect(messagesChanges(saved, { ...form, rebookText: ` ${limit} ` })).toEqual({
      changes: { rebookReminderText: limit },
    });
    expect(messagesChanges(saved, { ...form, rebookText: limit.repeat(100) })).toEqual({
      problem: 'rebookText',
    });
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
