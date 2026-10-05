import { isConfigured, SPEECH_LANG } from "./config.js";
import { generatePlan } from "./firebase.js";
import { addToGoogleCalendar, buildIcs } from "./calendar.js";

const $ = (sel) => document.querySelector(sel);

const els = {
  dateLabel: $("#date-label"),
  dayButtons: document.querySelectorAll(".segmented button"),
  banner: $("#setup-banner"),
  mic: $("#mic"),
  hint: $("#mic-hint"),
  dictation: $("#dictation"),
  planBtn: $("#plan-btn"),
  plan: $("#plan"),
  summary: $("#summary"),
  timeline: $("#timeline"),
  unscheduled: $("#unscheduled"),
  gcalBtn: $("#gcal-btn"),
  icsBtn: $("#ics-btn"),
  resetBtn: $("#reset-btn"),
  toast: $("#toast"),
};

const HINT_IDLE = "Натисніть і розкажіть, що у вас сьогодні";
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const STORAGE_KEY = "day-planner:v1";

const state = {
  dayOffset: 0,
  plan: null, // { summary, blocks: [{start, end, title, type, fixed, notes, included, eventId}], unscheduled }
};

// ---------- Dates ----------

function planDate() {
  const d = new Date();
  d.setDate(d.getDate() + state.dayOffset);
  return d;
}

function isoDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function hhmm(d) {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function dateLabel(d) {
  const label = d.toLocaleDateString("uk-UA", { weekday: "long", day: "numeric", month: "long" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function earliestStart() {
  if (state.dayOffset > 0) return "00:00";
  const d = new Date();
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15, 0, 0); // next quarter hour
  if (d.getDate() !== new Date().getDate()) return "23:59";
  return hhmm(d);
}

// ---------- Persistence (per day, so a refresh doesn't lose the plan) ----------

function save() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ date: isoDate(planDate()), dictation: els.dictation.value, plan: state.plan }),
    );
  } catch {}
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved) return;
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    if (saved.date === isoDate(tomorrow)) state.dayOffset = 1;
    else if (saved.date !== isoDate(today)) return;
    els.dictation.value = saved.dictation || "";
    state.plan = saved.plan;
  } catch {}
}

// ---------- UI helpers ----------

let toastTimer;
function toast(message, ms = 3500) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), ms);
}

function setLoading(btn, loading, label) {
  btn.classList.toggle("loading", loading);
  btn.disabled = loading;
  if (label) btn.querySelector(".label").textContent = label;
}

function autoGrow() {
  els.dictation.style.height = "auto";
  els.dictation.style.height = `${els.dictation.scrollHeight}px`;
}

function syncComposer() {
  autoGrow();
  els.planBtn.disabled = !isConfigured || !els.dictation.value.trim();
}

function renderDay() {
  els.dateLabel.textContent = dateLabel(planDate());
  els.dayButtons.forEach((b) =>
    b.setAttribute("aria-checked", String(Number(b.dataset.offset) === state.dayOffset)),
  );
  if (SpeechRecognition && !recording) els.hint.textContent = state.dayOffset ? "Натисніть і розкажіть, що у вас завтра" : HINT_IDLE;
}

const CHECK_SVG =
  '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.5l2.6 2.5L11 4.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function blockEl(block, index) {
  const li = document.createElement("li");
  li.className = `block type-${block.type || "task"}${block.included ? "" : " off"}`;

  const time = document.createElement("div");
  time.className = "time";
  time.innerHTML = `<span></span><span class="end"></span>`;
  time.children[0].textContent = block.start;
  time.children[1].textContent = block.end;

  const body = document.createElement("div");
  body.className = "body";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = block.title;
  body.append(title);

  const metaParts = [];
  if (block.eventId) metaParts.push("в календарі");
  else if (block.fixed) metaParts.push("фіксований час");
  if (metaParts.length || block.notes) {
    const meta = document.createElement("div");
    meta.className = "meta";
    if (metaParts.length) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = metaParts.join(" · ");
      meta.append(badge);
    }
    if (block.notes) meta.append(block.notes);
    body.append(meta);
  }

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "toggle";
  toggle.setAttribute("role", "checkbox");
  toggle.setAttribute("aria-checked", String(block.included));
  toggle.setAttribute("aria-label", `Додати «${block.title}» в календар`);
  toggle.innerHTML = CHECK_SVG;
  toggle.disabled = Boolean(block.eventId);
  toggle.addEventListener("click", () => {
    state.plan.blocks[index].included = !state.plan.blocks[index].included;
    save();
    renderPlan();
  });

  li.append(time, body, toggle);
  return li;
}

function renderSkeleton() {
  els.plan.hidden = false;
  els.summary.textContent = "Складаю план…";
  els.unscheduled.hidden = true;
  els.timeline.innerHTML = "";
  for (let i = 0; i < 4; i++) {
    const li = document.createElement("li");
    li.className = "block skeleton";
    li.innerHTML = '<div class="time"><span></span></div><div class="body"><span class="title"></span><span class="meta"></span></div><span></span>';
    els.timeline.append(li);
  }
  els.gcalBtn.disabled = true;
  els.icsBtn.disabled = true;
}

function renderPlan() {
  const plan = state.plan;
  if (!plan) {
    els.plan.hidden = true;
    return;
  }
  els.plan.hidden = false;
  els.summary.textContent = plan.summary || "";
  els.timeline.replaceChildren(...plan.blocks.map(blockEl));

  const list = els.unscheduled.querySelector("ul");
  list.replaceChildren(
    ...(plan.unscheduled || []).map((t) => Object.assign(document.createElement("li"), { textContent: t })),
  );
  els.unscheduled.hidden = !plan.unscheduled?.length;

  const pending = plan.blocks.filter((b) => b.included && !b.eventId);
  const added = plan.blocks.filter((b) => b.eventId).length;
  els.gcalBtn.disabled = !isConfigured || pending.length === 0;
  els.gcalBtn.querySelector(".label").textContent =
    pending.length === 0 && added
      ? "Додано в Google Calendar ✓"
      : added
        ? `Додати ще ${pending.length} в Google Calendar`
        : "Додати в Google Calendar";
  els.icsBtn.disabled = !plan.blocks.some((b) => b.included);
}

// ---------- Voice input (Web Speech API) ----------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recording = false;
let committedText = ""; // text before the current recognition session

function joinText(...parts) {
  return parts.map((p) => p.trim()).filter(Boolean).join(" ");
}

function startRecording() {
  committedText = els.dictation.value;
  recognition = new SpeechRecognition();
  recognition.lang = SPEECH_LANG;
  recognition.continuous = true;
  recognition.interimResults = true;

  let sessionFinal = "";
  recognition.onresult = (event) => {
    let finalText = "";
    let interim = "";
    for (const result of event.results) {
      if (result.isFinal) finalText += result[0].transcript + " ";
      else interim += result[0].transcript;
    }
    sessionFinal = finalText;
    els.dictation.value = joinText(committedText, finalText, interim);
    syncComposer();
  };

  recognition.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    stopRecording();
    toast(
      event.error === "not-allowed" || event.error === "service-not-allowed"
        ? "Дозвольте доступ до мікрофона в налаштуваннях браузера"
        : `Помилка розпізнавання: ${event.error}`,
    );
  };

  // Browsers end continuous sessions after a pause — keep listening until the user taps stop.
  recognition.onend = () => {
    committedText = joinText(committedText, sessionFinal);
    sessionFinal = "";
    if (recording) {
      try {
        recognition.start();
      } catch {
        stopRecording();
      }
    }
  };

  recognition.start();
  recording = true;
  els.mic.classList.add("recording");
  els.mic.setAttribute("aria-pressed", "true");
  els.mic.setAttribute("aria-label", "Зупинити запис");
  els.hint.textContent = "Слухаю… натисніть ще раз, щоб завершити";
}

function stopRecording() {
  recording = false;
  recognition?.stop();
  els.mic.classList.remove("recording");
  els.mic.setAttribute("aria-pressed", "false");
  els.mic.setAttribute("aria-label", "Почати запис");
  renderDay();
  save();
}

// ---------- Actions ----------

function normalizePlan(raw) {
  const blocks = (raw.blocks || [])
    .filter((b) => b && b.title && TIME_RE.test(b.start) && TIME_RE.test(b.end))
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((b) => ({ ...b, included: true, eventId: null }));
  return { summary: raw.summary || "", blocks, unscheduled: raw.unscheduled || [] };
}

async function makePlan() {
  if (recording) stopRecording();
  const dictation = els.dictation.value.trim();
  if (!dictation) return;

  const d = planDate();
  setLoading(els.planBtn, true, "Складаю план");
  renderSkeleton();
  try {
    const raw = await generatePlan(dictation, {
      dateLabel: d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
      isoDate: isoDate(d),
      nowTime: hhmm(new Date()),
      earliestStart: earliestStart(),
      timeZone: TIME_ZONE,
    });
    state.plan = normalizePlan(raw);
    if (!state.plan.blocks.length) toast("Не вдалося нічого розкласти — спробуйте розповісти детальніше");
    save();
    renderPlan();
    els.plan.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    console.error(err);
    renderPlan();
    toast(`Не вдалося скласти план: ${err.message || err}`, 6000);
  } finally {
    setLoading(els.planBtn, false, state.plan ? "Скласти план заново" : "Скласти план");
    syncComposer();
  }
}

async function exportToGoogle() {
  const pending = state.plan.blocks.filter((b) => b.included && !b.eventId);
  if (!pending.length) return;
  setLoading(els.gcalBtn, true, "Додаю в календар");
  let ids = [];
  try {
    ids = await addToGoogleCalendar(pending, isoDate(planDate()), TIME_ZONE);
    toast(`Готово: ${ids.length} ${plural(ids.length, "подія", "події", "подій")} у Google Calendar`);
  } catch (err) {
    console.error(err);
    ids = err.createdIds || [];
    const msg =
      err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request"
        ? "Вхід у Google скасовано"
        : err.code === "auth/popup-blocked"
          ? "Браузер заблокував вікно входу — дозвольте спливаючі вікна"
          : err.message;
    toast(msg, 6000);
  } finally {
    ids.forEach((id, i) => (pending[i].eventId = id));
    els.gcalBtn.classList.remove("loading");
    save();
    renderPlan();
  }
}

function downloadIcs() {
  const blocks = state.plan.blocks.filter((b) => b.included);
  const url = URL.createObjectURL(buildIcs(blocks, isoDate(planDate())));
  const a = Object.assign(document.createElement("a"), { href: url, download: `plan-${isoDate(planDate())}.ics` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reset() {
  if (recording) stopRecording();
  state.plan = null;
  els.dictation.value = "";
  setLoading(els.planBtn, false, "Скласти план");
  save();
  renderPlan();
  syncComposer();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---------- Wire up ----------

els.mic.addEventListener("click", () => (recording ? stopRecording() : startRecording()));
els.dictation.addEventListener("input", () => {
  syncComposer();
  save();
});
els.planBtn.addEventListener("click", makePlan);
els.gcalBtn.addEventListener("click", exportToGoogle);
els.icsBtn.addEventListener("click", downloadIcs);
els.resetBtn.addEventListener("click", reset);
els.dayButtons.forEach((b) =>
  b.addEventListener("click", () => {
    const offset = Number(b.dataset.offset);
    if (offset === state.dayOffset) return;
    state.dayOffset = offset;
    // Times from a plan for another day don't carry over.
    if (state.plan) {
      state.plan = null;
      setLoading(els.planBtn, false, "Скласти план");
      renderPlan();
    }
    renderDay();
    save();
  }),
);

if (!SpeechRecognition) {
  els.mic.disabled = true;
  els.hint.textContent = "Цей браузер не підтримує голосовий ввід — напишіть текстом або відкрийте в Chrome чи Safari";
}
els.banner.hidden = isConfigured;

restore();
renderDay();
renderPlan();
syncComposer();
if (state.plan) setLoading(els.planBtn, false, "Скласти план заново");
