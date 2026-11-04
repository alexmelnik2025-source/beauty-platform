import type { Locale } from '../generated/prisma/client';

/**
 * Sign-in code email of the "My visits" client app. Polish is the reference text;
 * the other versions must be proofread by native speakers before the beta.
 */
const WORDS: Record<Locale, { subject: string; text: (code: string) => string }> = {
  pl: {
    subject: 'Kod logowania do Twoich wizyt',
    text: (code) =>
      `Kod: ${code}\n\nWpisz go, aby zobaczyć swoje wizyty we wszystkich salonach. Kod jest ważny 10 minut.\nJeśli to nie Ty, zignoruj tę wiadomość.`,
  },
  uk: {
    subject: 'Код входу до ваших візитів',
    text: (code) =>
      `Код: ${code}\n\nВведіть його, щоб побачити свої візити в усіх салонах. Код дійсний 10 хвилин.\nЯкщо це були не ви, проігноруйте цей лист.`,
  },
  ru: {
    subject: 'Код входа в ваши визиты',
    text: (code) =>
      `Код: ${code}\n\nВведите его, чтобы увидеть свои визиты во всех салонах. Код действует 10 минут.\nЕсли это были не вы, проигнорируйте это письмо.`,
  },
  en: {
    subject: 'Your sign-in code for My visits',
    text: (code) =>
      `Code: ${code}\n\nEnter it to see your appointments in all salons. The code is valid for 10 minutes.\nIf this wasn't you, ignore this email.`,
  },
  tr: {
    subject: 'Randevularım için giriş kodu',
    text: (code) =>
      `Kod: ${code}\n\nTüm salonlardaki randevularınızı görmek için bu kodu girin. Kod 10 dakika geçerlidir.\nBu siz değilseniz, bu e-postayı dikkate almayın.`,
  },
  sq: {
    subject: 'Kodi i hyrjes për takimet tuaja',
    text: (code) =>
      `Kodi: ${code}\n\nShkruajeni për të parë takimet tuaja në të gjitha sallonet. Kodi është i vlefshëm 10 minuta.\nNëse nuk ishit ju, injorojeni këtë email.`,
  },
};

export function renderClientCodeEmail(
  locale: Locale,
  code: string,
): { subject: string; text: string } {
  const w = WORDS[locale];
  return { subject: w.subject, text: w.text(code) };
}
