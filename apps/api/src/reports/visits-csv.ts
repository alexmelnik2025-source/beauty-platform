/**
 * Task 22: the visits of a period as a CSV file for the salon's accountant. Excel opens it as
 * it is: UTF-8 with a byte order mark, ";" between the columns and a decimal comma (the way
 * Polish, Ukrainian and Russian spreadsheets expect it; English gets a decimal point).
 * No client contacts — only the name the salon sees in its calendar.
 */

export const CSV_LOCALES = ['pl', 'uk', 'ru', 'en'] as const;
export type CsvLocale = (typeof CSV_LOCALES)[number];

type Status = 'confirmed' | 'completed' | 'no_show' | 'cancelled';

interface CsvTexts {
  header: [
    date: string,
    time: string,
    specialist: string,
    service: string,
    client: string,
    status: string,
    source: string,
    price: string,
    discount: string,
    toPay: string,
    paid: string,
  ];
  status: Record<Status, string>;
  cancelledByClient: string;
  online: string;
  manual: string;
  yes: string;
  no: string;
  walkIn: string;
}

const TEXTS: Record<CsvLocale, CsvTexts> = {
  pl: {
    header: [
      'Data',
      'Godzina',
      'Specjalista',
      'Usługa',
      'Klient',
      'Status',
      'Rezerwacja',
      'Cena',
      'Rabat',
      'Do zapłaty',
      'Opłacono',
    ],
    status: {
      confirmed: 'Zaplanowana',
      completed: 'Odbyła się',
      no_show: 'Nie przyszedł',
      cancelled: 'Odwołana przez salon',
    },
    cancelledByClient: 'Odwołana przez klienta',
    online: 'Online',
    manual: 'Salon',
    yes: 'tak',
    no: 'nie',
    walkIn: 'Klient bez karty',
  },
  uk: {
    header: [
      'Дата',
      'Час',
      'Спеціаліст',
      'Послуга',
      'Клієнт',
      'Статус',
      'Запис',
      'Ціна',
      'Знижка',
      'До сплати',
      'Оплачено',
    ],
    status: {
      confirmed: 'Запланований',
      completed: 'Відбувся',
      no_show: 'Не прийшов',
      cancelled: 'Скасований салоном',
    },
    cancelledByClient: 'Скасований клієнтом',
    online: 'Онлайн',
    manual: 'Салон',
    yes: 'так',
    no: 'ні',
    walkIn: 'Клієнт без картки',
  },
  ru: {
    header: [
      'Дата',
      'Время',
      'Специалист',
      'Услуга',
      'Клиент',
      'Статус',
      'Запись',
      'Цена',
      'Скидка',
      'К оплате',
      'Оплачено',
    ],
    status: {
      confirmed: 'Запланирован',
      completed: 'Состоялся',
      no_show: 'Не пришёл',
      cancelled: 'Отменён салоном',
    },
    cancelledByClient: 'Отменён клиентом',
    online: 'Онлайн',
    manual: 'Салон',
    yes: 'да',
    no: 'нет',
    walkIn: 'Клиент без карты',
  },
  en: {
    header: [
      'Date',
      'Time',
      'Specialist',
      'Service',
      'Client',
      'Status',
      'Booked',
      'Price',
      'Discount',
      'To pay',
      'Paid',
    ],
    status: {
      confirmed: 'Upcoming',
      completed: 'Completed',
      no_show: 'No-show',
      cancelled: 'Cancelled by the salon',
    },
    cancelledByClient: 'Cancelled by the client',
    online: 'Online',
    manual: 'Salon',
    yes: 'yes',
    no: 'no',
    walkIn: 'Walk-in client',
  },
};

export interface CsvVisit {
  date: string;
  time: string;
  staff: string;
  service: string;
  client: string | null;
  status: Status;
  cancelledBy: 'customer' | 'salon' | null;
  online: boolean;
  priceGrosze: number;
  discountGrosze: number;
  paid: boolean;
}

/** One cell: quoted when it holds the separator, a quote or a line break; no formula injection. */
function cell(value: string): string {
  // A cell that starts with = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function amount(hundredths: number, locale: CsvLocale): string {
  const text = (hundredths / 100).toFixed(2);
  return locale === 'en' ? text : text.replace('.', ',');
}

export function visitsCsv(visits: CsvVisit[], locale: CsvLocale): string {
  const t = TEXTS[locale];
  const lines = [t.header.map(cell).join(';')];
  for (const v of visits) {
    const status =
      v.status === 'cancelled' && v.cancelledBy === 'customer'
        ? t.cancelledByClient
        : t.status[v.status];
    lines.push(
      [
        v.date,
        v.time,
        v.staff,
        v.service,
        v.client ?? t.walkIn,
        status,
        v.online ? t.online : t.manual,
        amount(v.priceGrosze, locale),
        amount(v.discountGrosze, locale),
        amount(v.priceGrosze - v.discountGrosze, locale),
        v.paid ? t.yes : t.no,
      ]
        .map(cell)
        .join(';'),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
