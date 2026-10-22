import type { Locale } from '../generated/prisma/client';

interface Template {
  subject: string;
  text: (name: string, link: string, token: string) => string;
}

// Plain-text templates. Polish is the legally binding language; other versions
// must be proofread by a native speaker before beta (see spec).
const verifyEmail: Record<Locale, Template> = {
  pl: {
    subject: 'Potwierdź adres e-mail',
    text: (name, link, token) =>
      `Cześć ${name},\n\nPotwierdź swój adres e-mail, otwierając link (ważny 24 godziny):\n${link}\n\nKod: ${token}\n\nJeśli to nie Ty zakładałeś konto, zignoruj tę wiadomość.`,
  },
  uk: {
    subject: 'Підтвердіть адресу електронної пошти',
    text: (name, link, token) =>
      `Вітаємо, ${name}!\n\nПідтвердіть свою адресу, відкривши посилання (дійсне 24 години):\n${link}\n\nКод: ${token}\n\nЯкщо ви не створювали акаунт, просто проігноруйте цей лист.`,
  },
  ru: {
    subject: 'Подтвердите адрес электронной почты',
    text: (name, link, token) =>
      `Здравствуйте, ${name}!\n\nПодтвердите свой адрес, открыв ссылку (действует 24 часа):\n${link}\n\nКод: ${token}\n\nЕсли вы не создавали аккаунт, просто проигнорируйте это письмо.`,
  },
  en: {
    subject: 'Confirm your email address',
    text: (name, link, token) =>
      `Hi ${name},\n\nConfirm your email address by opening this link (valid for 24 hours):\n${link}\n\nCode: ${token}\n\nIf you did not create an account, ignore this email.`,
  },
};

const resetPassword: Record<Locale, Template> = {
  pl: {
    subject: 'Reset hasła',
    text: (name, link, token) =>
      `Cześć ${name},\n\nAby ustawić nowe hasło, otwórz link (ważny 1 godzinę):\n${link}\n\nKod: ${token}\n\nJeśli to nie Ty prosiłeś o reset, zignoruj tę wiadomość — Twoje hasło się nie zmieni.`,
  },
  uk: {
    subject: 'Скидання пароля',
    text: (name, link, token) =>
      `Вітаємо, ${name}!\n\nЩоб встановити новий пароль, відкрийте посилання (дійсне 1 годину):\n${link}\n\nКод: ${token}\n\nЯкщо ви не просили скинути пароль, проігноруйте лист — пароль не зміниться.`,
  },
  ru: {
    subject: 'Сброс пароля',
    text: (name, link, token) =>
      `Здравствуйте, ${name}!\n\nЧтобы задать новый пароль, откройте ссылку (действует 1 час):\n${link}\n\nКод: ${token}\n\nЕсли вы не запрашивали сброс, проигнорируйте письмо — пароль не изменится.`,
  },
  en: {
    subject: 'Reset your password',
    text: (name, link, token) =>
      `Hi ${name},\n\nTo set a new password, open this link (valid for 1 hour):\n${link}\n\nCode: ${token}\n\nIf you did not request a reset, ignore this email — your password stays the same.`,
  },
};

export const templates = { verifyEmail, resetPassword };
