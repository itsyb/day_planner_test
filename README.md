# Мій день — голосовий планувальник

Натискаєте на мікрофон і розповідаєте, що у вас сьогодні: зустрічі, справи, що хотілося б встигнути. Gemini розкладає все в план по годинах, а одна кнопка додає його в Google Calendar.

- **Голос → текст:** Web Speech API у браузері (Chrome, Edge, Safari на macOS та iOS). Текст можна поправити руками перед тим, як скласти план.
- **План:** Gemini (`gemini-3.8-flash`) через [Firebase AI Logic](https://firebase.google.com/docs/ai-logic). Відповідь приходить як JSON за схемою, тож форма відповіді завжди однакова. Зустрічі з названим часом лишаються на своєму місці, задачам модель сама оцінює тривалість, а перерви, обід і дорогу вставляє там, де вони потрібні.
- **Календар:** вхід через Google (Firebase Auth) з доступом `calendar.events`, події пишуться в основний календар. Галочкою можна виключити окремі блоки. Запасний варіант — файл `.ics`, він працює з будь-яким календарем без входу.
- **Хостинг:** Firebase Hosting, статичні файли без кроку збірки.

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

**Перед тим як ділитися посиланням,** увімкніть [App Check](https://firebase.google.com/docs/ai-logic/app-check) для AI Logic. Gemini викликається прямо з браузера, і без App Check вашу квоту зможе витрачати будь-хто.

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
