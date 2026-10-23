import type { PublicAppointment } from '@/lib/types';

const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const escape = (text: string) => text.replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');

/** Downloads an .ics file so the client can add the visit to their phone's calendar. */
export function downloadIcs(a: PublicAppointment): void {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GESTALT//Booking//EN',
    'BEGIN:VEVENT',
    `UID:${a.id}@gestalt-booking`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(a.start)}`,
    `DTEND:${stamp(a.end)}`,
    `SUMMARY:${escape(`${a.service.name} — ${a.salon.name}`)}`,
    `LOCATION:${escape(`${a.salon.addressLine}, ${a.salon.postalCode} ${a.salon.city}`)}`,
    `DESCRIPTION:${escape(a.staff.displayName)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'wizyta.ics';
  link.click();
  URL.revokeObjectURL(url);
}
