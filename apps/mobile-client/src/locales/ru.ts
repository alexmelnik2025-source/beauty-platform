import type { Dictionary } from './pl';

export const ru: Dictionary = {
  appTitle: 'Визиты',
  signIn: {
    title: 'Мои визиты',
    subtitle:
      'Все ваши визиты во всех салонах — без пароля и без создания аккаунта. Укажите e-mail, на который вы записываетесь.',
    email: 'E-mail',
    badEmail: 'Введите адрес e-mail, например anna@example.com.',
    sendCode: 'Отправить код',
    sent: 'Мы отправили 6-значный код на {email}. Он действует 10 минут.',
    code: 'Код из письма',
    confirm: 'Войти',
    badCode: 'Неверный код. Проверьте почту и попробуйте ещё раз.',
    newCodeNeeded: 'Этот код уже не действует. Отправьте новый.',
    resend: 'Отправить код ещё раз',
    otherEmail: 'Другой e-mail',
  },
  visits: {
    title: 'Мои визиты',
    signedInAs: 'Вы вошли как {email}',
    upcoming: 'Предстоящие',
    past: 'История',
    emptyUpcoming: 'У вас нет запланированных визитов.',
    emptyPast: 'Здесь появятся ваши прошлые визиты.',
    refresh: 'Обновить',
    signOut: 'Выйти',
    minutes: 'мин',
    with: 'мастер: {staff}',
    status: {
      held: 'Бронирование не завершено',
      confirmed: 'Подтверждён',
      completed: 'Состоялся',
      no_show: 'Неявка',
      cancelled: 'Отменён',
      expired: 'Не завершено',
    },
  },
  language: 'Язык',
  error: {
    network: 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.',
    generic: 'Что-то пошло не так. Попробуйте ещё раз.',
    tooMany: 'Слишком много попыток. Подождите немного.',
  },
};
