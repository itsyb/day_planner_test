import { getCalendarAccessToken } from "./firebase.js";

// Google Calendar event colors: https://developers.google.com/calendar/api/v3/reference/colors
const COLOR_BY_TYPE = { focus: "3", meeting: "9", task: "5", errand: "7", break: "2", sport: "11", personal: "10" };

let cachedToken = null;
let cachedTokenExpiry = 0;

async function accessToken({ forceNew = false } = {}) {
  if (!forceNew && cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
  cachedToken = await getCalendarAccessToken();
  cachedTokenExpiry = Date.now() + 50 * 60 * 1000; // Google tokens live ~1h
  return cachedToken;
}

function toEvent(block, isoDate, timeZone) {
  const end = block.end > block.start ? block.end : "23:59";
  return {
    summary: block.title,
    description: [block.notes, "Створено в Day Planner"].filter(Boolean).join("\n\n"),
    start: { dateTime: `${isoDate}T${block.start}:00`, timeZone },
    end: { dateTime: `${isoDate}T${end}:00`, timeZone },
    colorId: COLOR_BY_TYPE[block.type],
  };
}

async function insertEvent(token, event) {
  return fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}

/**
 * Adds blocks to the user's primary Google Calendar.
 * Must be called from a click handler (opens a Google sign-in popup on first use).
 * @returns {Promise<string[]>} created event ids, in the same order as blocks
 */
export async function addToGoogleCalendar(blocks, isoDate, timeZone) {
  let token = await accessToken();
  const ids = [];
  for (const block of blocks) {
    const event = toEvent(block, isoDate, timeZone);
    let res = await insertEvent(token, event);
    if (res.status === 401) {
      token = await accessToken({ forceNew: true });
      res = await insertEvent(token, event);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const reason = body?.error?.message || res.statusText;
      const err = new Error(`Google Calendar: ${reason}`);
      err.createdIds = ids;
      throw err;
    }
    ids.push((await res.json()).id);
  }
  return ids;
}

function icsDate(isoDate, time) {
  // Local wall-clock time → UTC in iCalendar basic format.
  return new Date(`${isoDate}T${time}:00`).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icsEscape(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

/** Builds an .ics file — a fallback that works with any calendar app, no sign-in required. */
export function buildIcs(blocks, isoDate) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Day Planner//UK", "CALSCALE:GREGORIAN"];
  blocks.forEach((b, i) => {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${isoDate}-${i}-${stamp}@day-planner`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(isoDate, b.start)}`,
      `DTEND:${icsDate(isoDate, b.end > b.start ? b.end : "23:59")}`,
      `SUMMARY:${icsEscape(b.title)}`,
      ...(b.notes ? [`DESCRIPTION:${icsEscape(b.notes)}`] : []),
      "END:VEVENT",
    );
  });
  lines.push("END:VCALENDAR");
  return new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
}
