import { isConfigured, SPEECH_LANG } from "./config.js";
import { generatePlan, onUser, signOutUser } from "./firebase.js";
import { addToGoogleCalendar, buildIcs } from "./calendar.js";

const $ = (sel) => document.querySelector(sel);

const els = {
  datePill: $("#date-pill"),
  dateLabel: $("#date-label"),
  prevDay: $("#prev-day"),
  nextDay: $("#next-day"),
  calendar: $("#calendar"),
  calMonth: $("#cal-month"),
  calGrid: $("#cal-grid"),
  calPrev: $("#cal-prev"),
  calNext: $("#cal-next"),
  calToday: $("#cal-today"),
  avatar: $("#avatar"),
  banner: $("#setup-banner"),
  greeting: $("#greeting"),
  title: $("#composer-title"),
  field: $(".field"),
  dictation: $("#dictation"),
  live: $("#live"),
  liveFinal: $("#live .final"),
  liveInterim: $("#live .interim"),
  chips: $("#chips"),
  mic: $("#mic"),
  wave: $("#wave"),
  recTime: $("#rec-time"),
  recHint: $("#rec-hint"),
  planBtn: $("#plan-btn"),
  kbd: $("#kbd"),
  planMeta: $("#plan-meta"),
  why: $("#why"),
  whyText: $("#why-text"),
  timeline: $("#timeline"),
  unscheduled: $("#unscheduled"),
  gcalBtn: $("#gcal-btn"),
  icsBtn: $("#ics-btn"),
  toast: $("#toast"),
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const STORAGE_KEY = "day-planner:v2";
const LEGACY_STORAGE_KEY = "day-planner:v1";
const HOUR_PX = 48;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const IS_MOBILE = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

const state = {
  date: startOfDay(new Date()),
  days: {}, // "YYYY-MM-DD" → { dictation, plan }
  loadingKey: null, // date currently being planned by Gemini
  calMonth: null, // first day of the month shown in the calendar popover
};

// ---------- Dates & formatting ----------

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function isoDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const dayDiff = (d) => Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const nowMin = () => new Date().getHours() * 60 + new Date().getMinutes();
const hhmm = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const shortTime = (t) => t.replace(/^0(\d)/, "$1");

function duration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} хв`;
  if (m === 30) return `${h},5 год`;
  return m ? `${h} год ${m} хв` : `${h} год`;
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function dateLabel(d) {
  // Formatting weekday separately keeps it in the nominative case ("субота", not "суботу").
  const weekday = d.toLocaleDateString("uk-UA", { weekday: "long" });
  const opts = { day: "numeric", month: "long" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return `${capitalize(weekday)}, ${d.toLocaleDateString("uk-UA", opts)}`;
}

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Доброго ранку";
  if (h >= 12 && h < 18) return "Добрий день";
  if (h >= 18 && h < 23) return "Добрий вечір";
  return "Доброї ночі";
}

function composerTitle() {
  const diff = dayDiff(state.date);
  if (diff === 0) return "Розкажіть, що на вас сьогодні чекає";
  if (diff === 1) return "Розкажіть, що на вас чекає завтра";
  return `Розкажіть, що на вас чекає ${state.date.toLocaleDateString("uk-UA", { day: "numeric", month: "long" })}`;
}

function earliestStart() {
  if (dayDiff(state.date) !== 0) return "00:00";
  const d = new Date();
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15, 0, 0); // next quarter hour
  return d.getDate() === new Date().getDate() ? hhmm(d) : "23:59";
}

// ---------- State & persistence ----------

const currentKey = () => isoDate(state.date);

function day(key = currentKey()) {
  return (state.days[key] ||= { dictation: "", plan: null });
}

function save() {
  try {
    const days = Object.fromEntries(
      Object.entries(state.days).filter(([, d]) => d.plan || d.dictation?.trim()),
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ days }));
  } catch {}
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved?.days) {
      state.days = saved.days;
      return;
    }
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "null");
    if (legacy?.date) {
      const plan = legacy.plan ? { ...legacy.plan, rationale: legacy.plan.summary } : null;
      state.days[legacy.date] = { dictation: legacy.dictation || "", plan };
    }
  } catch {}
}

// ---------- Small UI helpers ----------

let toastTimer;
function toast(message, ms = 3500) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), ms);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const LOCK_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------- Header & calendar ----------

function renderHeader() {
  els.dateLabel.textContent = dateLabel(state.date);
}

function openCalendar() {
  state.calMonth = new Date(state.date.getFullYear(), state.date.getMonth(), 1);
  renderCalendar();
  els.calendar.hidden = false;
  els.datePill.setAttribute("aria-expanded", "true");
}

function closeCalendar() {
  els.calendar.hidden = true;
  els.datePill.setAttribute("aria-expanded", "false");
}

function renderCalendar() {
  const month = state.calMonth;
  els.calMonth.textContent = month
    .toLocaleDateString("uk-UA", { month: "long", year: "numeric" })
    .replace(/\s*р\.$/, "");

  const offset = (month.getDay() + 6) % 7; // weeks start on Monday
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Math.ceil((offset + daysInMonth) / 7) * 7;
  const first = addDays(month, -offset);
  const todayKey = isoDate(new Date());

  const buttons = [];
  for (let i = 0; i < cells; i++) {
    const d = addDays(first, i);
    const key = isoDate(d);
    const btn = el("button", "cal-day", String(d.getDate()));
    btn.type = "button";
    btn.setAttribute("aria-label", dateLabel(d));
    if (d.getMonth() !== month.getMonth()) btn.classList.add("outside");
    if (d.getDay() === 0 || d.getDay() === 6) btn.classList.add("weekend");
    if (key === todayKey) btn.classList.add("today");
    if (key === currentKey()) {
      btn.classList.add("selected");
      btn.setAttribute("aria-current", "date");
    }
    if (state.days[key]?.plan?.blocks?.length) btn.classList.add("has-plan");
    btn.addEventListener("click", () => {
      selectDate(d);
      closeCalendar();
    });
    buttons.push(btn);
  }
  els.calGrid.replaceChildren(...buttons);
}

function shiftCalendarMonth(delta) {
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + delta, 1);
  renderCalendar();
}

function selectDate(d) {
  if (recording) stopRecording();
  day().dictation = els.dictation.value;
  state.date = startOfDay(d);
  els.dictation.value = day().dictation;
  save();
  render();
}

// ---------- Composer ----------

const CHIP_GROUPS = [
  { types: ["meeting"], color: "var(--c-meeting)", label: (n) => `${n} ${plural(n, "зустріч", "зустрічі", "зустрічей")}` },
  { types: ["focus", "task", "errand"], color: "var(--c-focus)", label: (n) => `${n} ${plural(n, "задача", "задачі", "задач")}` },
  { types: ["personal", "sport"], color: "var(--c-personal)", label: (n) => `${n} особисте` },
];

function renderComposer() {
  els.greeting.textContent = greeting();
  els.title.textContent = composerTitle();

  const blocks = day().plan?.blocks || [];
  const chips = CHIP_GROUPS.map((g) => ({ ...g, n: blocks.filter((b) => g.types.includes(b.type)).length }))
    .filter((g) => g.n > 0)
    .map((g) => {
      const chip = el("span", "chip", g.label(g.n));
      chip.style.setProperty("--c", g.color);
      chip.prepend(el("i"));
      return chip;
    });
  els.chips.replaceChildren(...chips);
  els.chips.hidden = chips.length === 0;

  autoGrow();
  syncPlanButton();
}

function autoGrow() {
  els.dictation.style.height = "auto";
  els.dictation.style.height = `${els.dictation.scrollHeight}px`;
}

function syncPlanButton() {
  const loading = state.loadingKey === currentKey();
  els.planBtn.disabled = !isConfigured || Boolean(state.loadingKey) || !els.dictation.value.trim();
  els.planBtn.classList.toggle("loading", loading);
  els.planBtn.querySelector(".label").textContent = loading
    ? "Складаю план…"
    : day().plan
      ? "Оновити план"
      : "Скласти план";
}

// ---------- Plan ----------

function renderPlan() {
  const loading = state.loadingKey === currentKey();
  const plan = loading ? null : day().plan;
  const blocks = plan?.blocks || [];

  // Header line: "8 подій · 9:00 – 21:00 · 3,5 год вільного часу"
  if (loading) {
    els.planMeta.textContent = "Gemini розкладає ваш день…";
  } else if (blocks.length) {
    const end = blocks.reduce((max, b) => (b.end > max ? b.end : max), blocks[0].end);
    const parts = [
      `${blocks.length} ${plural(blocks.length, "подія", "події", "подій")}`,
      `${shortTime(blocks[0].start)} – ${shortTime(end)}`,
    ];
    const free = freeGaps(blocks).reduce((sum, g) => sum + (g.minutes >= 30 ? g.minutes : 0), 0);
    if (free) parts.push(`${duration(free)} вільного часу`);
    els.planMeta.textContent = parts.join(" · ");
  } else {
    els.planMeta.textContent = "Поки порожньо";
  }

  els.why.hidden = !plan?.rationale;
  els.whyText.textContent = plan?.rationale || "";

  renderTimeline(blocks, loading);

  const list = els.unscheduled.querySelector("ul");
  list.replaceChildren(...(plan?.unscheduled || []).map((t) => el("li", null, t)));
  els.unscheduled.hidden = !plan?.unscheduled?.length;

  const pending = blocks.filter((b) => b.included && !b.eventId);
  const added = blocks.filter((b) => b.eventId).length;
  els.gcalBtn.disabled = !isConfigured || pending.length === 0;
  els.gcalBtn.querySelector(".label").textContent =
    pending.length === 0 && added
      ? "В календарі ✓"
      : added
        ? `Додати ще ${pending.length}`
        : "Додати в Google Calendar";
  els.icsBtn.disabled = !blocks.some((b) => b.included);
}

function freeGaps(blocks) {
  const gaps = [];
  let cursor = null;
  for (const b of blocks) {
    if (cursor != null && toMin(b.start) > cursor) gaps.push({ from: cursor, to: toMin(b.start), minutes: toMin(b.start) - cursor });
    cursor = Math.max(cursor ?? 0, toMin(b.end));
  }
  return gaps;
}

function renderTimeline(blocks, loading) {
  const tl = els.timeline;
  let startH = 9;
  let endH = 18;
  if (blocks.length) {
    startH = Math.floor(toMin(blocks[0].start) / 60);
    endH = Math.ceil(Math.max(...blocks.map((b) => toMin(b.end))) / 60);
  }
  endH = Math.max(endH, startH + 4);

  const y = (min) => ((min - startH * 60) / 60) * HOUR_PX;
  const nodes = [];

  for (let h = startH; h <= endH; h++) {
    const line = el("div", "hour");
    line.style.top = `${y(h * 60)}px`;
    line.append(el("span", null, `${String(h).padStart(2, "0")}:00`));
    nodes.push(line);
  }

  if (loading) {
    [[9 * 60 + 10, 50], [10 * 60 + 15, 35], [11 * 60, 80], [13 * 60, 55], [14 * 60 + 15, 25], [16 * 60, 70]].forEach(
      ([start, len], i) => {
        const sk = el("div", "skeleton");
        sk.style.top = `${y(start)}px`;
        sk.style.height = `${(len / 60) * HOUR_PX}px`;
        sk.style.animationDelay = `${i * 0.12}s`;
        nodes.push(sk);
      },
    );
  } else if (!blocks.length) {
    nodes.push(el("div", "empty", "Надиктуйте або напишіть, що у вас заплановано, — план з'явиться тут"));
  } else {
    for (const gap of freeGaps(blocks)) {
      if (gap.minutes < 60) continue;
      const free = el("div", "free", `Вільно · ${duration(gap.minutes)}`);
      free.style.top = `${y(gap.from) + 3}px`;
      free.style.height = `${y(gap.to) - y(gap.from) - 6}px`;
      nodes.push(free);
    }
    blocks.forEach((block, i) => nodes.push(eventEl(block, i, y)));
  }

  const now = nowMin();
  if (dayDiff(state.date) === 0 && now >= startH * 60 && now <= endH * 60) {
    const line = el("div", "now");
    line.style.top = `${y(now)}px`;
    line.append(el("span", null, hhmm(new Date())));
    nodes.push(line);
  }

  tl.style.height = `${(endH - startH) * HOUR_PX + 12}px`;
  tl.replaceChildren(...nodes);
}

function eventEl(block, index, y) {
  const start = toMin(block.start);
  const end = toMin(block.end);
  const height = Math.max(((end - start) / 60) * HOUR_PX - 3, 20);
  const compact = height < 40;
  const diff = dayDiff(state.date);
  const past = diff < 0 || (diff === 0 && end <= nowMin());

  const btn = el("button", `event type-${block.type || "task"}`);
  btn.type = "button";
  if (compact) btn.classList.add("compact");
  if (past) btn.classList.add("past");
  if (!block.included) btn.classList.add("off");
  btn.style.top = `${y(start) + 1}px`;
  btn.style.height = `${height}px`;
  btn.style.animationDelay = `${index * 25}ms`;
  btn.setAttribute("aria-pressed", String(block.included));
  btn.title = block.eventId
    ? "Вже в Google Calendar"
    : block.included
      ? "Натисніть, щоб не додавати в календар"
      : "Натисніть, щоб додати в календар";

  const main = el("div", "event-main");
  main.append(el("div", "event-title", block.title));
  const time = `${shortTime(block.start)} – ${shortTime(block.end)}`;
  main.append(el("div", "event-sub", compact || !block.notes ? time : `${time} · ${block.notes}`));
  btn.append(main);

  if (block.eventId) {
    const badge = el("span", "event-badge added");
    badge.innerHTML = CHECK_SVG;
    badge.append(el("span", "badge-text", "В календарі"));
    btn.append(badge);
  } else if (block.fixed) {
    const badge = el("span", "event-badge");
    badge.innerHTML = LOCK_SVG;
    badge.append(el("span", "badge-text", "Фіксовано"));
    badge.title = "Фіксований час";
    btn.append(badge);
  }

  btn.addEventListener("click", () => {
    if (block.eventId) return toast("Ця подія вже в Google Calendar");
    block.included = !block.included;
    save();
    renderPlan();
  });
  return btn;
}

function render() {
  renderHeader();
  renderComposer();
  renderPlan();
  if (!els.calendar.hidden) renderCalendar();
}

// ---------- Voice input (Web Speech API) + waveform ----------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recording = false;
let committedText = ""; // text before the current recognition session
let startedAt = 0;
let clock = null;
let lastSpeechAt = 0;

const joinText = (...parts) =>
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/[ \t]{2,}/g, " ");

const wave = { bars: [], levels: [], timer: null, stream: null, audioCtx: null, analyser: null };

function setupWaveBars() {
  const count = Math.max(12, Math.floor(els.wave.clientWidth / 6));
  wave.bars = Array.from({ length: count }, () => el("span", "quiet"));
  els.wave.replaceChildren(...wave.bars);
  wave.levels = [];
  drawWave();
}

function drawWave() {
  wave.bars.forEach((bar, i) => {
    const level = wave.levels[i] ?? 0;
    bar.style.height = `${3 + level * 34}px`;
    bar.classList.toggle("quiet", level < 0.06);
  });
}

async function startWave() {
  setupWaveBars();
  // Mobile browsers don't like two consumers of the microphone, so there we animate from speech events.
  if (!IS_MOBILE && navigator.mediaDevices?.getUserMedia) {
    try {
      wave.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      wave.audioCtx = new AudioContext();
      wave.analyser = wave.audioCtx.createAnalyser();
      wave.analyser.fftSize = 512;
      wave.audioCtx.createMediaStreamSource(wave.stream).connect(wave.analyser);
    } catch {
      wave.analyser = null;
    }
  }
  const buf = new Uint8Array(512);
  wave.timer = setInterval(() => {
    let level;
    if (wave.analyser) {
      wave.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      level = Math.min(1, Math.sqrt(sum / buf.length) * 5);
    } else {
      level = Date.now() - lastSpeechAt < 500 ? 0.25 + Math.random() * 0.65 : Math.random() * 0.05;
    }
    wave.levels.push(level);
    if (wave.levels.length > wave.bars.length) wave.levels.shift();
    drawWave();
  }, 80);
}

function stopWave() {
  clearInterval(wave.timer);
  wave.stream?.getTracks().forEach((t) => t.stop());
  wave.audioCtx?.close();
  Object.assign(wave, { timer: null, stream: null, audioCtx: null, analyser: null });
}

function renderRecorder() {
  if (!SpeechRecognition) {
    els.recTime.textContent = "";
    els.recHint.textContent = "Голос — у Chrome чи Safari";
    return;
  }
  if (recording) {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    els.recTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    els.recHint.textContent = "Слухаю…";
  } else {
    els.recTime.textContent = "";
    els.recHint.textContent = "Натисніть і говоріть";
  }
}

function startRecording() {
  committedText = els.dictation.value;
  recognition = new SpeechRecognition();
  recognition.lang = SPEECH_LANG;
  recognition.continuous = true;
  recognition.interimResults = true;

  let sessionFinal = "";
  recognition.onresult = (event) => {
    if (!recording) return;
    let finalText = "";
    let interim = "";
    for (const result of event.results) {
      if (result.isFinal) finalText += result[0].transcript + " ";
      else interim += result[0].transcript;
    }
    sessionFinal = finalText;
    lastSpeechAt = Date.now();
    const finalAll = joinText(committedText, finalText);
    els.liveFinal.textContent = finalAll;
    els.liveInterim.textContent = interim;
    els.dictation.value = joinText(finalAll, interim);
    syncPlanButton();
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
    if (!recording) return;
    committedText = joinText(committedText, sessionFinal);
    sessionFinal = "";
    try {
      recognition.start();
    } catch {
      stopRecording();
    }
  };

  recognition.start();
  recording = true;
  startedAt = Date.now();
  els.liveFinal.textContent = committedText;
  els.liveInterim.textContent = "";
  els.field.classList.add("recording");
  els.live.hidden = false;
  els.mic.classList.add("recording");
  els.mic.setAttribute("aria-pressed", "true");
  els.mic.setAttribute("aria-label", "Зупинити запис");
  clock = setInterval(renderRecorder, 250);
  renderRecorder();
  startWave();
}

function stopRecording() {
  recording = false;
  recognition?.stop();
  clearInterval(clock);
  stopWave();
  els.field.classList.remove("recording");
  autoGrow();
  els.live.hidden = true;
  els.mic.classList.remove("recording");
  els.mic.setAttribute("aria-pressed", "false");
  els.mic.setAttribute("aria-label", "Почати запис");
  day().dictation = els.dictation.value;
  save();
  renderRecorder();
  setupWaveBars();
  syncPlanButton();
}

// ---------- Actions ----------

function normalizePlan(raw) {
  const blocks = (raw.blocks || [])
    .filter((b) => b && b.title && TIME_RE.test(b.start) && TIME_RE.test(b.end) && b.end > b.start)
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((b) => ({ ...b, included: true, eventId: null }));
  return { rationale: raw.rationale || "", blocks, unscheduled: raw.unscheduled || [] };
}

async function makePlan() {
  if (recording) stopRecording();
  const dictation = els.dictation.value.trim();
  if (!dictation || state.loadingKey) return;

  const date = new Date(state.date);
  const key = isoDate(date);
  const entry = day(key);
  const hadEvents = entry.plan?.blocks?.some((b) => b.eventId);
  entry.dictation = els.dictation.value;
  state.loadingKey = key;
  render();

  try {
    const raw = await generatePlan(dictation, {
      dateLabel: date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
      isoDate: key,
      nowTime: hhmm(new Date()),
      earliestStart: earliestStart(),
      timeZone: TIME_ZONE,
    });
    entry.plan = normalizePlan(raw);
    if (!entry.plan.blocks.length) toast("Не вдалося нічого розкласти — спробуйте розповісти детальніше");
    else if (hadEvents) toast("Події з попереднього плану лишились у календарі — нові додадуться окремо", 5000);
    save();
  } catch (err) {
    console.error(err);
    const status = err?.customErrorData?.status ?? Number(/\[(\d{3})/.exec(err?.message || "")?.[1]);
    toast(
      status === 429
        ? "Денний ліміт безкоштовних запитів до Gemini вичерпано — спробуйте завтра або увімкніть тариф Blaze"
        : status >= 500
          ? "Gemini зараз перевантажений — спробуйте за хвилину"
          : `Не вдалося скласти план: ${err.message || err}`,
      7000,
    );
  } finally {
    state.loadingKey = null;
    render();
  }
}

async function exportToGoogle() {
  const key = currentKey();
  const pending = day(key).plan.blocks.filter((b) => b.included && !b.eventId);
  if (!pending.length) return;
  els.gcalBtn.disabled = true;
  els.gcalBtn.classList.add("loading");
  els.gcalBtn.querySelector(".label").textContent = "Додаю";
  let ids = [];
  try {
    ids = await addToGoogleCalendar(pending, key, TIME_ZONE);
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
  const key = currentKey();
  const blocks = day(key).plan.blocks.filter((b) => b.included);
  const url = URL.createObjectURL(buildIcs(blocks, key));
  Object.assign(el("a"), { href: url, download: `plan-${key}.ics` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Account ----------

function initials(user) {
  const name = user.displayName || user.email || "";
  const parts = name.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "•";
}

onUser((user) => {
  els.avatar.hidden = !user;
  if (!user) return;
  els.avatar.title = `${user.displayName || ""} ${user.email ? `(${user.email})` : ""}`.trim();
  els.avatar.setAttribute("aria-label", `Акаунт ${user.email || ""}. Натисніть, щоб вийти`);
  if (user.photoURL) {
    const img = el("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = user.photoURL;
    img.onerror = () => (els.avatar.textContent = initials(user));
    els.avatar.replaceChildren(img);
  } else {
    els.avatar.textContent = initials(user);
  }
});

els.avatar.addEventListener("click", async () => {
  if (confirm("Вийти з Google-акаунта?")) {
    await signOutUser();
    toast("Ви вийшли з акаунта");
  }
});

// ---------- Wire up ----------

els.mic.addEventListener("click", () => (recording ? stopRecording() : startRecording()));
els.dictation.addEventListener("input", () => {
  day().dictation = els.dictation.value;
  autoGrow();
  syncPlanButton();
  save();
});
els.planBtn.addEventListener("click", makePlan);
els.gcalBtn.addEventListener("click", exportToGoogle);
els.icsBtn.addEventListener("click", downloadIcs);

els.datePill.addEventListener("click", (e) => {
  e.stopPropagation();
  els.calendar.hidden ? openCalendar() : closeCalendar();
});
els.prevDay.addEventListener("click", () => selectDate(addDays(state.date, -1)));
els.nextDay.addEventListener("click", () => selectDate(addDays(state.date, 1)));
els.calPrev.addEventListener("click", () => shiftCalendarMonth(-1));
els.calNext.addEventListener("click", () => shiftCalendarMonth(1));
els.calToday.addEventListener("click", () => {
  selectDate(new Date());
  closeCalendar();
});
els.calendar.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => !els.calendar.hidden && closeCalendar());

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.calendar.hidden) closeCalendar();
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !els.planBtn.disabled) {
    e.preventDefault();
    makePlan();
  }
});

// Keep the "now" line and past events current.
setInterval(() => {
  if (dayDiff(state.date) === 0 && !state.loadingKey) renderPlan();
}, 60_000);

els.kbd.textContent = IS_MAC ? "⌘ ↵" : "Ctrl ↵";
els.mic.disabled = !SpeechRecognition;
els.banner.hidden = isConfigured;

restore();
els.dictation.value = day().dictation;
render();
renderRecorder();
setupWaveBars();
