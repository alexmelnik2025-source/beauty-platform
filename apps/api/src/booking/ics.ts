/**
 * Task 20: "Add to calendar". One visit as an iCalendar file (RFC 5545) that Google
 * Calendar, Apple Calendar and Outlook open. Times are in UTC (…Z), so every calendar
 * shows them in its own time zone without a VTIMEZONE block. The UID stays the same for
 * a visit and SEQUENCE grows with each change, so importing the file again after a move
 * updates the event instead of adding a second one.
 */

export interface IcsEvent {
  /** Stable for the visit, e.g. `<appointment id>@beauty-platform`. */
  uid: string;
  /** Grows with every change of the visit (its version). */
  sequence: number;
  start: Date;
  end: Date;
  /** e.g. "Strzyżenie — Berber Moda". */
  summary: string;
  /** Address of the salon. */
  location: string;
  description: string;
  /** Where the client changes or cancels the visit. */
  url?: string;
  cancelled: boolean;
  /** Reminder this many minutes before the start; omitted = no reminder. */
  alarmMinutesBefore?: number;
  /** When the file was made (DTSTAMP). */
  now: Date;
}

/** 20261120T090000Z */
export function icsTime(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

/** Text values: backslash, semicolon, comma and line breaks are escaped (RFC 5545 3.3.11). */
export function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Lines longer than 75 octets are folded: CRLF and one space (RFC 5545 3.1). A multi-byte
 * letter (ł, ж, ı) is never cut in half.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (size + bytes > limit) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function buildIcs(event: IcsEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Beauty Platform//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsText(event.uid)}`,
    `SEQUENCE:${event.sequence}`,
    `DTSTAMP:${icsTime(event.now)}`,
    `DTSTART:${icsTime(event.start)}`,
    `DTEND:${icsTime(event.end)}`,
    `SUMMARY:${icsText(event.summary)}`,
    `LOCATION:${icsText(event.location)}`,
    `DESCRIPTION:${icsText(event.description)}`,
    ...(event.url ? [`URL:${event.url}`] : []),
    `STATUS:${event.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    ...(event.alarmMinutesBefore && !event.cancelled
      ? [
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          `DESCRIPTION:${icsText(event.summary)}`,
          `TRIGGER:-PT${event.alarmMinutesBefore}M`,
          'END:VALARM',
        ]
      : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
