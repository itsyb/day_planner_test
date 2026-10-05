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
You maintain the user's plan for one day. You receive the current plan (possibly empty) and what the user just said (messy speech-to-text): new meetings, tasks, wishes, or changes to existing items.
Reply with the CHANGES to apply to the plan, not the whole plan.

Editing rules:
- Every existing block stays exactly as it is unless the user asks to change it, or it must move to make room for a new fixed-time item.
- New items go to "add". Changes to existing blocks go to "update" (id plus only the fields that change). Blocks the user cancels or wants removed go to "remove" (ids).
- Never remove or rewrite blocks the user did not mention. If the user only adds something, "update" and "remove" are usually empty.
- Never move blocks that already ended (end before the current time) and never move fixed blocks unless asked.
- "unscheduled" is the full new list of things that do not fit (keep earlier items unless they are now scheduled or dropped).

Planning rules:
- Items with a stated time (meetings, calls, appointments) keep exactly that time and get fixed=true.
- If a duration is not stated, estimate a realistic one: small to-dos (reply, pay, call back) take 15–30 minutes, errands 30–45 minutes plus travel. Split big creative work into a draft and a final block when it helps.
- Put demanding focus work earlier in the day when possible.
- Add lunch if the day spans midday and there is none yet, and short breaks between long blocks. Combine errands with trips when it is natural (e.g. pick up a parcel on the way from lunch).
- Never schedule new items before the earliest start time given in the context.
- Default working window is 08:00–22:00 unless the user says otherwise.
- After applying your changes there must be no overlaps. Use 24h "HH:MM". A block must end after it starts and no later than 23:59.
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
- "rationale" is one short sentence (max ~15 words) about the key decisions of THIS change, e.g. "презентація — на ранок, поки є фокус. Посилка — по дорозі з обіду."`;

const TYPES = ["focus", "meeting", "task", "errand", "break", "sport", "personal"];

const newBlockSchema = Schema.object({
  properties: {
    start: Schema.string({ description: "Start time, HH:MM 24h" }),
    end: Schema.string({ description: "End time, HH:MM 24h" }),
    title: Schema.string(),
    type: Schema.enumString({ enum: TYPES }),
    fixed: Schema.boolean({ description: "True if the user stated this exact time" }),
    notes: Schema.string(),
  },
  optionalProperties: ["notes"],
});

const blockUpdateSchema = Schema.object({
  properties: {
    id: Schema.string({ description: "id of an existing block" }),
    start: Schema.string(),
    end: Schema.string(),
    title: Schema.string(),
    type: Schema.enumString({ enum: TYPES }),
    fixed: Schema.boolean(),
    notes: Schema.string(),
  },
  optionalProperties: ["start", "end", "title", "type", "fixed", "notes"],
});

const changesSchema = Schema.object({
  properties: {
    rationale: Schema.string(),
    add: Schema.array({ items: newBlockSchema }),
    update: Schema.array({ items: blockUpdateSchema }),
    remove: Schema.array({ items: Schema.string({ description: "id of a block to remove" }) }),
    unscheduled: Schema.array({ items: Schema.string() }),
  },
});

const models = GEMINI_MODELS.map((name) =>
  getGenerativeModel(ai, {
    model: name,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: changesSchema,
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
 * Asks Gemini how to change the day's plan.
 * @param {string} request  what the user just said
 * @param {{blocks: object[], unscheduled: string[]}} plan  current plan (blocks carry ids)
 * @param {{dateLabel: string, isoDate: string, nowTime: string, earliestStart: string, timeZone: string}} ctx
 * @returns {Promise<{rationale: string, add: object[], update: object[], remove: string[], unscheduled: string[]}>}
 */
export async function requestPlanChanges(request, plan, ctx) {
  const current = plan.blocks.length
    ? plan.blocks
        .map(({ id, start, end, title, type, fixed, notes }) => JSON.stringify({ id, start, end, title, type, fixed, notes }))
        .join("\n")
    : "(empty — this is the first request for the day)";
  const prompt = `Context:
- Plan date: ${ctx.dateLabel} (${ctx.isoDate})
- Current local time: ${ctx.nowTime}
- Time zone: ${ctx.timeZone}
- Earliest start time for new items: ${ctx.earliestStart}

Current plan:
${current}

Currently unscheduled: ${plan.unscheduled.length ? plan.unscheduled.join("; ") : "(nothing)"}

What the user just said:
"""
${request}
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
