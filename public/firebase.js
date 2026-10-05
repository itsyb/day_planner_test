import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  Schema,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-ai.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js";
import { firebaseConfig, GEMINI_MODELS, RECAPTCHA_ENTERPRISE_SITE_KEY } from "./config.js";

const app = initializeApp(firebaseConfig);
// App Check proves requests to Gemini come from this site, so nobody else can spend the quota.
if (RECAPTCHA_ENTERPRISE_SITE_KEY) {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
}
const auth = getAuth(app);
const ai = getAI(app, { backend: new GoogleAIBackend() });

const SYSTEM_PROMPT = `You are a calm, practical personal day planner.
The user dictates (via messy speech-to-text) everything they have for the day: meetings with fixed times, tasks, errands and things they would like to fit in.
Turn it into a realistic hour-by-hour schedule.

Rules:
- Items with a stated time (meetings, calls, appointments) keep exactly that time and get fixed=true.
- If a duration is not stated, estimate a realistic one: small to-dos (reply, pay, call back) take 15–30 minutes, errands 30–45 minutes plus travel. Split big creative work into a draft and a final block when it helps.
- Put demanding focus work earlier in the day when possible.
- Add lunch if the day spans midday and short breaks between long blocks. Combine errands with trips when it is natural (e.g. pick up a parcel on the way from lunch).
- Never schedule anything before the earliest start time given in the context.
- Default working window is 08:00–22:00 unless the user says otherwise.
- No overlaps. Use 24h "HH:MM". Sort blocks by start time. A block must end after it starts and no later than 23:59.
- Leave free time free; do not pad the day with invented activities.
- If something does not fit, list it in "unscheduled" instead of squeezing it in.
- Do not invent tasks the user did not mention (lunch, breaks and travel are the only exception).

Block types:
- focus: deep work that needs concentration (writing, presentations, coding).
- meeting: calls and meetings with other people.
- task: small to-dos (reply, pay, book, send).
- errand: going somewhere (shop, post office, pick up).
- break: lunch, rest, travel.
- sport: gym, running, training.
- personal: family, hobbies, reading, time off screens.

Language:
- Write titles, notes and rationale in the same language the user spoke.
- Titles are short calendar-style names (up to ~5 words).
- Notes are optional, 2–4 useful words, e.g. "Глибока робота · без сповіщень". Omit generic notes like "Важливо" or "Перерва".
- "rationale" is one short sentence (max ~15 words) explaining the key placement decisions, e.g. "презентація — на ранок, поки є фокус. Посилка — по дорозі з обіду."`;

const planSchema = Schema.object({
  properties: {
    rationale: Schema.string(),
    blocks: Schema.array({
      items: Schema.object({
        properties: {
          start: Schema.string({ description: "Start time, HH:MM 24h" }),
          end: Schema.string({ description: "End time, HH:MM 24h" }),
          title: Schema.string(),
          type: Schema.enumString({
            enum: ["focus", "meeting", "task", "errand", "break", "sport", "personal"],
          }),
          fixed: Schema.boolean({ description: "True if the user stated this exact time" }),
          notes: Schema.string(),
        },
        optionalProperties: ["notes"],
      }),
    }),
    unscheduled: Schema.array({ items: Schema.string() }),
  },
});

const models = GEMINI_MODELS.map((name) =>
  getGenerativeModel(ai, {
    model: name,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: planSchema,
      temperature: 0.4,
      // Planning a day doesn't need long deliberation; low thinking keeps responses fast.
      thinkingConfig: { thinkingLevel: "LOW" },
    },
  }),
);

const errorStatus = (err) => err?.customErrorData?.status ?? Number(/\[(\d{3})/.exec(err?.message || "")?.[1]);

// Out of quota (429) or overloaded (5xx): switch to the next model in the chain.
const isUnavailable = (err) => [429, 500, 503].includes(errorStatus(err));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} dictation  what the user said
 * @param {{dateLabel: string, isoDate: string, nowTime: string, earliestStart: string, timeZone: string}} ctx
 */
export async function generatePlan(dictation, ctx) {
  const prompt = `Context:
- Plan date: ${ctx.dateLabel} (${ctx.isoDate})
- Current local time: ${ctx.nowTime}
- Time zone: ${ctx.timeZone}
- Earliest start time: ${ctx.earliestStart}

What the user said:
"""
${dictation}
"""`;

  let lastError;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text());
      } catch (err) {
        lastError = err;
        if (!isUnavailable(err)) throw err;
        if (errorStatus(err) === 429) break; // quota won't come back in a second
        if (attempt === 0) await wait(1200);
      }
    }
  }
  throw lastError;
}

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

/** Calls back with the signed-in Firebase user (or null) now and on every change. */
export function onUser(callback) {
  return onAuthStateChanged(auth, callback);
}

export function signOutUser() {
  return signOut(auth);
}

/** Signs in with Google and returns an OAuth access token that can write calendar events. */
export async function getCalendarAccessToken() {
  const provider = new GoogleAuthProvider();
  provider.addScope(CALENDAR_SCOPE);
  provider.setCustomParameters({ prompt: "select_account" });
  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (!credential?.accessToken) throw new Error("Google не повернув токен доступу до календаря.");
  return credential.accessToken;
}
