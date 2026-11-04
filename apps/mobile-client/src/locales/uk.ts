import type { Dictionary } from './pl';

export const uk: Dictionary = {
  appTitle: 'Візити',
  signIn: {
    title: 'Мої візити',
    subtitle:
      'Усі ваші візити в усіх салонах — без пароля і без створення акаунта. Вкажіть e-mail, на який ви записуєтеся.',
    email: 'E-mail',
    badEmail: 'Введіть адресу e-mail, напр. anna@example.com.',
    sendCode: 'Надіслати код',
    sent: 'Ми надіслали 6-значний код на {email}. Він дійсний 10 хвилин.',
    code: 'Код з e-mail',
    confirm: 'Увійти',
    badCode: 'Неправильний код. Перевірте пошту й спробуйте ще раз.',
    newCodeNeeded: 'Цей код уже не діє. Надішліть новий.',
    resend: 'Надіслати код ще раз',
    otherEmail: 'Інший e-mail',
  },
  visits: {
    title: 'Мої візити',
    signedInAs: 'Ви увійшли як {email}',
    upcoming: 'Майбутні',
    past: 'Історія',
    emptyUpcoming: 'У вас немає запланованих візитів.',
    emptyPast: 'Тут з’являться ваші попередні візити.',
    refresh: 'Оновити',
    signOut: 'Вийти',
    minutes: 'хв',
    with: 'майстер: {staff}',
    status: {
      held: 'Бронювання триває',
      confirmed: 'Підтверджено',
      completed: 'Відбувся',
      no_show: 'Неявка',
      cancelled: 'Скасовано',
      expired: 'Не завершено',
    },
  },
  language: 'Мова',
  error: {
    network: 'Немає з’єднання із сервером. Перевірте інтернет і спробуйте ще раз.',
    generic: 'Щось пішло не так. Спробуйте ще раз.',
    tooMany: 'Забагато спроб. Зачекайте трохи.',
  },
};
