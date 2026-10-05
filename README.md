# Мій день — голосовий планувальник

Натискаєте на мікрофон і розповідаєте, що у вас сьогодні: зустрічі, справи, що хотілося б встигнути. Gemini розкладає все в план по годинах, а одна кнопка додає його в Google Calendar.

- **Голос → текст:** Web Speech API у браузері (Chrome, Edge, Safari на macOS та iOS). Поки ви говорите, видно хвилю голосу й таймер, а нерозпізнаний до кінця текст виділено сірим. Текст можна поправити руками.
- **Будь-який день року:** натисніть на дату вгорі, і відкриється календар місяця; стрілки поруч перемикають сусідні дні. План кожного дня зберігається окремо, а дні з планом позначені крапкою.
- **План:** Gemini через [Firebase AI Logic](https://firebase.google.com/docs/ai-logic). Відповідь приходить як JSON за схемою. Зустрічі з названим часом лишаються на місці, задачам модель сама оцінює тривалість, додає обід і перерви, а в рядку «Чому так» пояснює, чому розклала саме так.
- **Таймлайн:** сітка по годинах, кольори за типом блоку (фокус, зустріч, задача, справа поза домом, перерва, спорт, особисте), червона лінія поточного часу, вільні вікна від години.
- **Календар:** вхід через Google (Firebase Auth) з доступом `calendar.events`, події пишуться в основний календар. Натисканням на блок його можна виключити з експорту. Запасний варіант — файл `.ics`.
- **Хостинг:** Firebase Hosting, статичні файли без кроку збірки.

### Ліміти Gemini

На безкоштовному тарифі Gemini Developer API кожна модель має невеликий денний ліміт запитів, наприклад 20 на добу для `gemini-3.8-flash`. Тому в `GEMINI_MODELS` у [`public/config.js`](public/config.js) задано ланцюжок моделей: коли одна вичерпала ліміт або перевантажена, план складає наступна. Щоб ліміти були високими, перейдіть на тариф Blaze. Один план коштує частки цента.

## Налаштування (≈10 хвилин)

1. **Проєкт Firebase.** Створіть проєкт у [Firebase Console](https://console.firebase.google.com). Безкоштовного плану Spark достатньо.
2. **Веб-застосунок.** Project settings → Your apps → Add app → Web. Скопіюйте `firebaseConfig` у [`public/config.js`](public/config.js), а ID проєкту впишіть у [`.firebaserc`](.firebaserc).
3. **Gemini.** У консолі відкрийте **AI Logic** → Get started → оберіть **Gemini Developer API**.
4. **Вхід через Google.** Authentication → Sign-in method → **Google** → Enable.
5. **Google Calendar API.** У [Google Cloud Console](https://console.cloud.google.com) (це той самий проєкт) відкрийте APIs & Services → Library → **Google Calendar API** → Enable.
6. **Екран згоди OAuth.** Google Auth Platform:
   - **Data access** → Add scopes → `https://www.googleapis.com/auth/calendar.events`.
   - **Audience** → залиште режим *Testing* і додайте свою Gmail-адресу в **Test users**.

   Під час входу Google покаже попередження «застосунок не перевірено». Для особистого використання це нормально: Advanced → Continue.

> **Корпоративні акаунти Google Workspace** можуть блокувати сторонні застосунки з доступом до календаря. Якщо вхід не проходить, перевірте з особистим Gmail або попросіть адміністратора дозволити застосунок.

## Запуск

```bash
npm install
npm run dev          # http://localhost:5000
```

`localhost` уже є серед дозволених доменів Firebase Auth, а мікрофон на ньому працює без HTTPS.

## Деплой

```bash
npx firebase login
npm run deploy       # https://<project-id>.web.app
```

**App Check.** Gemini викликається прямо з браузера, тому [App Check](https://firebase.google.com/docs/ai-logic/app-check) захищає квоту від чужих запитів. У Firebase Console → App Check → Apps зареєструйте веб-застосунок із провайдером **reCAPTCHA Enterprise** і вставте site key у `RECAPTCHA_ENTERPRISE_SITE_KEY` у [`public/config.js`](public/config.js). Якщо для AI Logic увімкнено enforcement, без ключа Gemini відповідатиме помилкою «App Check token is invalid».

## Структура

```
public/
  index.html     розмітка
  styles.css     дизайн (світла й темна тема)
  app.js         UI, мікрофон, стан, збереження в localStorage
  firebase.js    ініціалізація Firebase, промпт і схема для Gemini, вхід через Google
  calendar.js    запис подій у Google Calendar і генерація .ics
  config.js      конфіг Firebase, модель і мова розпізнавання
```

## Обмеження першої версії

- У Firefox немає Web Speech API, тому там працює лише текстовий ввід.
- Блоки плану не можна редагувати напряму. Щоб змінити план, поправте текст і натисніть «Скласти план заново».
- Події завжди потрапляють в основний календар (`primary`).
