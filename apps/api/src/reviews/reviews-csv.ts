/**
 * Task 407: every review of the salon as a CSV file — for the owner's own analysis or a
 * marketing summary. Newest first. Same file format as the visits CSV (task 30): UTF-8 with a
 * byte order mark, ";" between the columns. The client's name as in "Opinie" (empty once the
 * client's data was erased); no phone or e-mail.
 */

import { cell, type CsvLocale } from '../reports/visits-csv';

export interface ReviewCsvLine {
  /** The visit's day and time, salon time. */
  visitDate: string;
  visitTime: string;
  rating: number;
  staff: string;
  service: string;
  client: string | null;
  text: string | null;
  reply: string | null;
  /** When the client wrote it, the salon's date. */
  writtenOn: string;
}

const HEADER: Record<CsvLocale, string[]> = {
  pl: [
    'Data wizyty',
    'Godzina',
    'Ocena',
    'Specjalista',
    'Usługa',
    'Klient',
    'Opinia',
    'Odpowiedź salonu',
    'Data opinii',
  ],
  uk: [
    'Дата візиту',
    'Час',
    'Оцінка',
    'Майстер',
    'Послуга',
    'Клієнт',
    'Відгук',
    'Відповідь салону',
    'Дата відгуку',
  ],
  ru: [
    'Дата визита',
    'Время',
    'Оценка',
    'Мастер',
    'Услуга',
    'Клиент',
    'Отзыв',
    'Ответ салона',
    'Дата отзыва',
  ],
  en: [
    'Visit date',
    'Time',
    'Rating',
    'Specialist',
    'Service',
    'Client',
    'Review',
    'Salon reply',
    'Written on',
  ],
};

export function reviewsCsv(lines: ReviewCsvLine[], locale: CsvLocale): string {
  const out = [HEADER[locale].map(cell).join(';')];
  for (const l of lines) {
    out.push(
      [
        cell(l.visitDate),
        cell(l.visitTime),
        String(l.rating),
        cell(l.staff),
        cell(l.service),
        cell(l.client ?? ''),
        cell(l.text ?? ''),
        cell(l.reply ?? ''),
        cell(l.writtenOn),
      ].join(';'),
    );
  }
  return `﻿${out.join('\r\n')}\r\n`;
}
