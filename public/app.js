import { isConfigured, SPEECH_LANG } from "./config.js";
import { onUser, requestPlanChanges, signOutUser } from "./firebase.js";
import { buildIcs, syncToGoogleCalendar } from "./calendar.js";

const $ = (sel) => document.querySelector(sel);

const els = {
  dateBtn: $("#date-btn"),
  dateNum: $("#date-num"),
  dateWeekday: $("#date-weekday"),
  dateMonth: $("#date-month"),
  prevDay: $("#prev-day"),
  nextDay: $("#next-day"),
  todayBtn: $("#today-btn"),
  calendar: $("#calendar"),
  calMonth: $("#cal-month"),
  calGrid: $("#cal-grid"),
  calPrev: $("#cal-prev"),
  calNext: $("#cal-next"),
  avatar: $("#avatar"),
  banner: $("#setup-banner"),
  dayStatus: $("#day-status"),
  composition: $("#composition"),
  compBar: $("#comp-bar"),
  compLegend: $("#comp-legend"),
  why: $("#why"),
  history: $("#history"),
  unscheduled: $("#unscheduled"),
  planActions: $("#plan-actions"),
  gcalBtn: $("#gcal-btn"),
  icsBtn: $("#ics-btn"),
  clearBtn: $("#clear-btn"),
  timeline: $("#timeline"),
  dock: $("#dock"),
  dictation: $("#dictation"),
  live: $("#live"),
  liveFinal: $("#live .final"),
  liveInterim: $("#live .interim"),
  mic: $("#mic"),
  recRow: $("#rec-row"),
  recTime: $("#rec-time"),
  wave: $("#wave"),
  planBtn: $("#plan-btn"),
  dockHint: $("#dock-hint"),
  toast: $("#toast"),
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const STORAGE_KEY = "day-planner:v2";
const LEGACY_STORAGE_KEY = "day-planner:v1";
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

function dayWord() {
  const diff = dayDiff(state.date);
  if (diff === 0) return "сьогодні";
  if (diff === 1) return "завтра";
  if (diff === -1) return "вчора";
  return state.date.toLocaleDateString("uk-UA", { day: "numeric", month: "long" });
}

const hourPx = () =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour")) || 52;

function earliestStart() {
  if (dayDiff(state.date) !== 0) return "00:00";
  const d = new Date();
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15, 0, 0); // next quarter hour
  return d.getDate() === new Date().getDate() ? hhmm(d) : "23:59";
}

// ---------- State & persistence ----------

const currentKey = () => isoDate(state.date);

function day(key = currentKey()) {
  return (state.days[key] ||= { dictation: "", plan: null, history: [] });
}

const newId = () => `b${Math.random().toString(36).slice(2, 8)}`;

function save() {
  try {
    const days = Object.fromEntries(
      Object.entries(state.days).filter(([, d]) => d.plan || d.dictation?.trim() || d.history?.length),
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ days }));
  } catch {}
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved?.days) {
      state.days = saved.days;
      // Plans saved before editing existed have no block ids.
      for (const d of Object.values(state.days)) d.plan?.blocks?.forEach((b) => (b.id ||= newId()));
      return;
    }
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "null");
    if (legacy?.date) {
      const plan = legacy.plan
        ? { ...legacy.plan, rationale: legacy.plan.summary, blocks: legacy.plan.blocks.map((b) => ({ ...b, id: newId() })) }
        : null;
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
  const d = state.date;
  els.dateNum.textContent = d.getDate();
  els.dateWeekday.textContent = d.toLocaleDateString("uk-UA", { weekday: "long" });
  // "5 жовтня" → "жовтня", keeping the genitive form.
  const month = d.toLocaleDateString("uk-UA", { day: "numeric", month: "long" }).replace(/^\d+\s*/, "");
  els.dateMonth.textContent = `${month} ${d.getFullYear()}`;
  els.dateBtn.setAttribute("aria-label", `${dateLabel(d)}. Обрати інший день`);
  els.todayBtn.disabled = dayDiff(d) === 0;
  document.title = `${dateLabel(d)} — день.`;
}

function openCalendar() {
  state.calMonth = new Date(state.date.getFullYear(), state.date.getMonth(), 1);
  renderCalendar();
  els.calendar.hidden = false;
  els.dateBtn.setAttribute("aria-expanded", "true");
}

function closeCalendar() {
  els.calendar.hidden = true;
  els.dateBtn.setAttribute("aria-expanded", "false");
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

function renderComposer() {
  const editing = Boolean(day().plan?.blocks?.length);
  els.dictation.placeholder = editing ? "Що додати чи змінити?" : `Розкажіть, що у вас ${dayWord()}…`;
  els.dockHint.textContent = !SpeechRecognition
    ? "голосовий ввід — у Chrome чи Safari · Enter — надіслати"
    : editing
      ? "напр.: «о 16:00 зустріч з Андрієм» — решта плану збережеться"
      : "мікрофон або текст · зустрічі, справи, бажання — у будь-якому порядку";
  renderHistory();
  autoGrow();
  syncPlanButton();
}

function renderHistory() {
  const history = day().history || [];
  els.history.hidden = history.length === 0;
  if (!history.length) return;
  els.history.querySelector("summary").textContent = `ви казали · ${history.length}`;
  els.history.querySelector("ol").replaceChildren(...history.map((h) => el("li", null, h.text)));
}

function autoGrow() {
  els.dictation.style.height = "auto";
  els.dictation.style.height = `${Math.min(els.dictation.scrollHeight, 168)}px`;
}

function syncPlanButton() {
  const loading = state.loadingKey === currentKey();
  const editing = Boolean(day().plan?.blocks?.length);
  els.planBtn.disabled = !isConfigured || Boolean(state.loadingKey) || !els.dictation.value.trim();
  els.planBtn.setAttribute("aria-label", editing ? "Оновити план" : "Скласти план");
  els.dock.classList.toggle("loading", loading);
}

// ---------- Plan ----------

const GROUPS = [
  { key: "focus", label: "фокус", types: ["focus"] },
  { key: "meeting", label: "зустрічі", types: ["meeting"] },
  { key: "tasks", label: "справи", types: ["task", "errand"] },
  { key: "break", label: "перерви", types: ["break"] },
  { key: "personal", label: "особисте", types: ["personal", "sport"] },
];

const hm = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

function renderPlan() {
  const loading = state.loadingKey === currentKey();
  const plan = loading ? null : day().plan;
  const blocks = plan?.blocks || [];
  const editing = Boolean(day().plan?.blocks?.length);

  // "8 подій · 9:00–21:00"
  if (loading) {
    els.dayStatus.textContent = editing ? "оновлюю план…" : "складаю план…";
  } else if (blocks.length) {
    const end = blocks.reduce((max, b) => (b.end > max ? b.end : max), blocks[0].end);
    els.dayStatus.textContent = `${blocks.length} ${plural(blocks.length, "подія", "події", "подій")} · ${shortTime(blocks[0].start)}–${shortTime(end)}`;
  } else {
    els.dayStatus.textContent = "план порожній";
  }

  renderComposition(blocks);

  els.why.hidden = !plan?.rationale;
  els.why.textContent = plan?.rationale || "";

  renderTimeline(blocks, loading);

  const list = els.unscheduled.querySelector("ul");
  list.replaceChildren(...(plan?.unscheduled || []).map((t) => el("li", null, t)));
  els.unscheduled.hidden = !plan?.unscheduled?.length;

  els.planActions.hidden = !blocks.length;
  const ops = plan ? calendarOps(plan) : [];
  const synced = blocks.some((b) => b.eventId) || plan?.removedEventIds?.length;
  els.gcalBtn.disabled = !isConfigured || ops.length === 0;
  els.gcalBtn.querySelector(".label").textContent = !synced
    ? "Додати в Google Calendar"
    : ops.length
      ? `Оновити календар · ${ops.length}`
      : "У календарі ✓";
  els.icsBtn.disabled = !blocks.some((b) => b.included);
}

/** Proportions of the day: how much is focus, meetings, errands, breaks, personal and free time. */
function renderComposition(blocks) {
  els.composition.hidden = !blocks.length;
  if (!blocks.length) return;
  const minutes = (b) => toMin(b.end) - toMin(b.start);
  const groups = GROUPS.map((g) => ({
    ...g,
    min: blocks.filter((b) => g.types.includes(b.type)).reduce((sum, b) => sum + minutes(b), 0),
  }));
  const free = freeGaps(blocks).reduce((sum, g) => sum + g.minutes, 0);
  const rows = [...groups, { key: "free", label: "вільно", min: free }].filter((g) => g.min > 0);

  els.compBar.replaceChildren(
    ...rows.map((g) => {
      const seg = el("span", `sw-${g.key}`);
      seg.style.flexGrow = g.min;
      seg.title = `${g.label} · ${hm(g.min)}`;
      return seg;
    }),
  );
  els.compLegend.replaceChildren(
    ...rows.map((g) => {
      const li = el("li");
      li.append(el("i", `sw-${g.key}`), g.label, el("b", null, hm(g.min)));
      return li;
    }),
  );
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

// Overlapping blocks (rare, but possible after edits) sit side by side instead of on top of each other.
function layoutColumns(blocks) {
  let group = [];
  let columns = [];
  let groupEnd = -1;
  const flush = () => group.forEach((b) => (b._cols = columns.length));
  for (const b of blocks) {
    const start = toMin(b.start);
    if (start >= groupEnd) {
      flush();
      group = [];
      columns = [];
    }
    let col = columns.findIndex((end) => end <= start);
    if (col === -1) col = columns.push(0) - 1;
    columns[col] = toMin(b.end);
    b._col = col;
    group.push(b);
    groupEnd = Math.max(groupEnd, toMin(b.end));
  }
  flush();
}

function renderTimeline(blocks, loading) {
  const tl = els.timeline;
  const HOUR = hourPx();
  let startH = 8;
  let endH = 20;
  if (blocks.length) {
    startH = Math.floor(toMin(blocks[0].start) / 60);
    endH = Math.ceil(Math.max(...blocks.map((b) => toMin(b.end))) / 60);
  }
  endH = Math.max(endH, startH + 4);

  const y = (min) => ((min - startH * 60) / 60) * HOUR;
  const nodes = [];

  for (let h = startH; h <= endH; h++) {
    const line = el("div", "hour");
    line.style.top = `${y(h * 60)}px`;
    const label = el("span", null, String(h).padStart(2, "0"));
    label.append(el("small", null, ":00"));
    line.append(label);
    nodes.push(line);
    if (h < endH) {
      const half = el("div", "hour half");
      half.style.top = `${y(h * 60 + 30)}px`;
      nodes.push(half);
    }
  }

  // Time that has already passed today is hatched, like a page that's been written on.
  const now = nowMin();
  const diff = dayDiff(state.date);
  const pastUntil = diff < 0 ? endH * 60 : diff === 0 ? Math.min(Math.max(now, startH * 60), endH * 60) : startH * 60;
  if (pastUntil > startH * 60 && (blocks.length || loading)) {
    const past = el("div", "past-zone");
    past.style.height = `${y(pastUntil)}px`;
    nodes.push(past);
  }

  if (loading) {
    [[startH * 60 + 15, 50], [startH * 60 + 75, 35], [startH * 60 + 130, 80], [startH * 60 + 240, 55], [startH * 60 + 320, 70]].forEach(
      ([start, len], i) => {
        const sk = el("div", "skeleton");
        sk.style.top = `${y(start)}px`;
        sk.style.height = `${(len / 60) * HOUR}px`;
        sk.style.animationDelay = `${i * -0.2}s`;
        nodes.push(sk);
      },
    );
  } else if (!blocks.length) {
    const empty = el("div", "empty");
    empty.append(
      el("h2", null, "Чистий аркуш."),
      el("p", null, "Натисніть на мікрофон унизу й розкажіть про день: зустрічі, справи, що хотілося б встигнути. План з'явиться тут."),
    );
    nodes.push(empty);
  } else {
    for (const gap of freeGaps(blocks)) {
      if (gap.minutes < 60) continue;
      const free = el("button", "free");
      free.type = "button";
      free.style.top = `${y(gap.from) + 3}px`;
      free.style.height = `${y(gap.to) - y(gap.from) - 6}px`;
      free.append(el("span", null, `вільне вікно · ${duration(gap.minutes)}`), el("span", "add", "+ додати"));
      free.addEventListener("click", () => suggestInGap(gap));
      nodes.push(free);
    }
    layoutColumns(blocks);
    blocks.forEach((block, i) => nodes.push(eventEl(block, i, y, HOUR)));
  }

  if (diff === 0 && now >= startH * 60 && now <= endH * 60) {
    const line = el("div", "now");
    line.style.top = `${y(now)}px`;
    line.append(el("span", null, hhmm(new Date())));
    nodes.push(line);
  }

  tl.style.height = `${(endH - startH) * HOUR + 12}px`;
  tl.replaceChildren(...nodes);
}

/** Clicking a free window starts a request with its time, ready to dictate or type the rest. */
function suggestInGap(gap) {
  const start = Math.max(gap.from, dayDiff(state.date) === 0 ? toMin(earliestStart()) : 0);
  const rounded = Math.ceil(start / 15) * 15;
  const time = `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
  els.dictation.value = `О ${time} `;
  day().dictation = els.dictation.value;
  syncPlanButton();
  autoGrow();
  els.dictation.focus();
  els.dictation.setSelectionRange(els.dictation.value.length, els.dictation.value.length);
}

const renderedIds = new Set();

function eventEl(block, index, y, HOUR) {
  const start = toMin(block.start);
  const end = toMin(block.end);
  const height = Math.max(((end - start) / 60) * HOUR - 3, 22);
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
  btn.style.setProperty("--col", block._col ?? 0);
  btn.style.setProperty("--cols", block._cols ?? 1);
  // Only blocks that weren't on screen before fade in, so edits don't replay the whole plan.
  if (!renderedIds.has(block.id)) {
    btn.classList.add("appear");
    btn.style.animationDelay = `${index * 25}ms`;
    renderedIds.add(block.id);
  }
  btn.setAttribute("aria-pressed", String(block.included));
  btn.title = block.included
    ? block.eventId
      ? "Натисніть, щоб прибрати з Google Calendar"
      : "Натисніть, щоб не додавати в календар"
    : "Натисніть, щоб додати в календар";

  const main = el("div", "event-main");
  main.append(el("div", "event-title", block.title));
  const sub = el("div", "event-sub");
  sub.append(el("span", "t", `${block.start}–${block.end}`));
  if (!compact && block.notes) sub.append(` · ${block.notes}`);
  main.append(sub);
  btn.append(main);

  if (block.eventId && block.included) {
    const badge = el("span", `event-badge ${block.dirty ? "changed" : "added"}`);
    badge.innerHTML = CHECK_SVG;
    badge.append(el("span", "badge-text", block.dirty ? "змінено" : "у календарі"));
    if (block.dirty) badge.title = "Змінено після додавання — натисніть «Оновити календар»";
    btn.append(badge);
  } else if (block.fixed) {
    const badge = el("span", "event-badge");
    badge.innerHTML = LOCK_SVG;
    badge.append(el("span", "badge-text", "фікс."));
    badge.title = "Фіксований час";
    btn.append(badge);
  }

  btn.addEventListener("click", () => {
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
let recClock = null;
let lastSpeechAt = 0;

const joinText = (...parts) =>
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/[ \t]{2,}/g, " ");

const wave = { bars: [], levels: [], timer: null, stream: null, audioCtx: null, analyser: null };

function setupWaveBars() {
  const count = Math.max(16, Math.floor(els.wave.clientWidth / 4));
  wave.bars = Array.from({ length: count }, () => el("span", "quiet"));
  els.wave.replaceChildren(...wave.bars);
  wave.levels = [];
  drawWave();
}

function drawWave() {
  wave.bars.forEach((bar, i) => {
    const level = wave.levels[i] ?? 0;
    bar.style.height = `${2 + level * 20}px`;
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
  if (!recording) return;
  const s = Math.floor((Date.now() - startedAt) / 1000);
  els.recTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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
  els.dock.classList.add("recording");
  els.recRow.hidden = false;
  els.live.hidden = false;
  els.mic.classList.add("recording");
  els.mic.setAttribute("aria-pressed", "true");
  els.mic.setAttribute("aria-label", "Зупинити запис");
  recClock = setInterval(renderRecorder, 250);
  renderRecorder();
  startWave();
}

function stopRecording() {
  recording = false;
  recognition?.stop();
  clearInterval(recClock);
  stopWave();
  els.dock.classList.remove("recording");
  els.recRow.hidden = true;
  autoGrow();
  els.live.hidden = true;
  els.mic.classList.remove("recording");
  els.mic.setAttribute("aria-pressed", "false");
  els.mic.setAttribute("aria-label", "Почати запис");
  day().dictation = els.dictation.value;
  save();
  syncPlanButton();
}

// ---------- Actions ----------

const EDITABLE = ["start", "end", "title", "type", "fixed", "notes"];
const validTimes = (b) => TIME_RE.test(b.start) && TIME_RE.test(b.end) && b.end > b.start;

/** Applies Gemini's add/update/remove to the plan; everything it didn't mention stays untouched. */
function applyChanges(plan, changes) {
  const blocks = plan.blocks.map((b) => ({ ...b }));
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const removedEventIds = [...(plan.removedEventIds || [])];

  for (const update of changes.update || []) {
    const block = byId.get(update.id);
    if (!block) continue;
    const next = { ...block };
    for (const key of EDITABLE) if (update[key] !== undefined && update[key] !== "") next[key] = update[key];
    if (!validTimes(next) || !next.title) continue;
    const changed = EDITABLE.some((key) => (next[key] ?? "") !== (block[key] ?? ""));
    Object.assign(block, next, { dirty: Boolean(block.dirty || (changed && block.eventId)) });
  }

  const removeIds = new Set(changes.remove || []);
  const kept = blocks.filter((b) => {
    if (!removeIds.has(b.id)) return true;
    if (b.eventId) removedEventIds.push(b.eventId);
    return false;
  });

  const added = (changes.add || [])
    .filter((b) => b && b.title && validTimes(b))
    .map((b) => ({
      id: newId(),
      start: b.start,
      end: b.end,
      title: b.title,
      type: b.type,
      fixed: Boolean(b.fixed),
      notes: b.notes || "",
      included: true,
      eventId: null,
      dirty: false,
    }));

  return {
    rationale: changes.rationale || plan.rationale || "",
    blocks: [...kept, ...added].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end)),
    unscheduled: Array.isArray(changes.unscheduled) ? changes.unscheduled : plan.unscheduled || [],
    removedEventIds,
  };
}

async function makePlan() {
  if (recording) stopRecording();
  const request = els.dictation.value.trim();
  if (!request || state.loadingKey) return;

  const date = new Date(state.date);
  const key = isoDate(date);
  const entry = day(key);
  const plan = entry.plan || { rationale: "", blocks: [], unscheduled: [], removedEventIds: [] };
  entry.dictation = els.dictation.value;
  state.loadingKey = key;
  render();

  try {
    const changes = await requestPlanChanges(request, plan, {
      dateLabel: date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
      isoDate: key,
      nowTime: hhmm(new Date()),
      earliestStart: earliestStart(),
      timeZone: TIME_ZONE,
    });
    const next = applyChanges(plan, changes);
    const touched = (changes.add?.length || 0) + (changes.update?.length || 0) + (changes.remove?.length || 0);
    if (!touched && !next.blocks.length) {
      toast("Не вдалося нічого розкласти — спробуйте розповісти детальніше");
    } else {
      entry.plan = next;
      (entry.history ||= []).push({ text: request, at: Date.now() });
      entry.dictation = "";
      if (key === currentKey()) els.dictation.value = "";
      if (!touched) toast("План не змінився — спробуйте сказати інакше");
    }
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

/** What has to happen in Google Calendar for it to match the plan. */
function calendarOps(plan) {
  const ops = [];
  for (const block of plan.blocks) {
    if (block.included && !block.eventId) ops.push({ kind: "create", block });
    else if (block.included && block.dirty) ops.push({ kind: "update", block });
    else if (!block.included && block.eventId) ops.push({ kind: "delete", eventId: block.eventId, block });
  }
  for (const eventId of plan.removedEventIds || []) ops.push({ kind: "delete", eventId });
  return ops;
}

async function exportToGoogle() {
  const key = currentKey();
  const plan = day(key).plan;
  const ops = calendarOps(plan);
  if (!ops.length) return;
  els.gcalBtn.disabled = true;
  els.gcalBtn.classList.add("loading");
  els.gcalBtn.querySelector(".label").textContent = "Синхронізую";
  const done = { create: 0, update: 0, delete: 0 };
  try {
    await syncToGoogleCalendar(ops, key, TIME_ZONE, (op, eventId) => {
      done[op.kind]++;
      if (op.kind === "delete") {
        if (op.block) op.block.eventId = null;
        else plan.removedEventIds = plan.removedEventIds.filter((id) => id !== op.eventId);
      } else {
        op.block.eventId = eventId;
        op.block.dirty = false;
      }
      save();
    });
    const parts = [];
    if (done.create) parts.push(`додано ${done.create}`);
    if (done.update) parts.push(`оновлено ${done.update}`);
    if (done.delete) parts.push(`видалено ${done.delete}`);
    toast(`Google Calendar: ${parts.join(", ")}`);
  } catch (err) {
    console.error(err);
    const msg =
      err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request"
        ? "Вхід у Google скасовано"
        : err.code === "auth/popup-blocked"
          ? "Браузер заблокував вікно входу — дозвольте спливаючі вікна"
          : err.message;
    toast(msg, 6000);
  } finally {
    els.gcalBtn.classList.remove("loading");
    save();
    renderPlan();
  }
}

function clearDay() {
  const entry = day();
  const synced = entry.plan?.blocks?.some((b) => b.eventId);
  const question = synced
    ? "Очистити план на цей день? Події, які вже в Google Calendar, залишаться там."
    : "Очистити план на цей день?";
  if (!confirm(question)) return;
  entry.plan = null;
  entry.history = [];
  save();
  render();
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
els.dock.addEventListener("submit", (e) => {
  e.preventDefault();
  makePlan();
});
// Enter sends, Shift+Enter starts a new line — like a message.
els.dictation.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!els.planBtn.disabled) makePlan();
  }
});
els.gcalBtn.addEventListener("click", exportToGoogle);
els.icsBtn.addEventListener("click", downloadIcs);
els.clearBtn.addEventListener("click", clearDay);

els.dateBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  els.calendar.hidden ? openCalendar() : closeCalendar();
});
els.prevDay.addEventListener("click", () => selectDate(addDays(state.date, -1)));
els.nextDay.addEventListener("click", () => selectDate(addDays(state.date, 1)));
els.calPrev.addEventListener("click", () => shiftCalendarMonth(-1));
els.calNext.addEventListener("click", () => shiftCalendarMonth(1));
els.todayBtn.addEventListener("click", () => selectDate(new Date()));
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

els.mic.disabled = !SpeechRecognition;
els.banner.hidden = isConfigured;

restore();
els.dictation.value = day().dictation;
render();
