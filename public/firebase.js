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
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js";
import { firebaseConfig, GEMINI_MODEL, RECAPTCHA_ENTERPRISE_SITE_KEY } from "./config.js";

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
- If a duration is not stated, estimate a reasonable one.
- Put demanding focus work earlier in the day when possible.
- Add short breaks between long blocks, lunch if the day spans midday, and travel time when the user mentions going somewhere. Mark these as type "break".
- Never schedule anything before the earliest start time given in the context.
- Default working window is 08:00–22:00 unless the user says otherwise.
- No overlaps. Use 24h "HH:MM". Sort blocks by start time. A block must end after it starts and no later than 23:59.
- If something does not fit, list it in "unscheduled" instead of squeezing it in.
- Do not invent tasks the user did not mention (breaks, lunch and travel are the only exception).
- Titles are short calendar-style names (up to ~6 words). Notes are optional and brief.
- Write titles, notes and summary in the same language the user spoke.
- "summary" is one friendly sentence describing the shape of the day.`;

const planSchema = Schema.object({
  properties: {
    summary: Schema.string(),
    blocks: Schema.array({
      items: Schema.object({
        properties: {
          start: Schema.string({ description: "Start time, HH:MM 24h" }),
          end: Schema.string({ description: "End time, HH:MM 24h" }),
          title: Schema.string(),
          type: Schema.enumString({ enum: ["meeting", "task", "personal", "break"] }),
          fixed: Schema.boolean({ description: "True if the user stated this exact time" }),
          notes: Schema.string(),
        },
        optionalProperties: ["notes"],
      }),
    }),
    unscheduled: Schema.array({ items: Schema.string() }),
  },
});

const model = getGenerativeModel(ai, {
  model: GEMINI_MODEL,
  systemInstruction: SYSTEM_PROMPT,
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema: planSchema,
    temperature: 0.4,
  },
});

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

  const result = await model.generateContent(prompt);
  return JSON.parse(result.response.text());
}

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

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
