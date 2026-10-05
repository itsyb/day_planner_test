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

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

function request(token, op, isoDate, timeZone) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  if (op.kind === "create") {
    return fetch(EVENTS_URL, { method: "POST", headers, body: JSON.stringify(toEvent(op.block, isoDate, timeZone)) });
  }
  if (op.kind === "update") {
    return fetch(`${EVENTS_URL}/${encodeURIComponent(op.block.eventId)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(toEvent(op.block, isoDate, timeZone)),
    });
  }
  return fetch(`${EVENTS_URL}/${encodeURIComponent(op.eventId)}`, { method: "DELETE", headers });
}

/**
 * Brings the user's primary Google Calendar in line with the plan.
 * Must be called from a click handler (opens a Google sign-in popup on first use).
 * @param {Array<{kind: "create"|"update", block: object} | {kind: "delete", eventId: string}>} ops
 * @param {(op: object, eventId: string|null) => void} onDone  called after each applied op,
 *   so progress is kept even if a later op fails; eventId is null when the event no longer exists
 */
export async function syncToGoogleCalendar(ops, isoDate, timeZone, onDone) {
  let token = await accessToken();
  for (const op of ops) {
    let res = await request(token, op, isoDate, timeZone);
    if (res.status === 401) {
      token = await accessToken({ forceNew: true });
      res = await request(token, op, isoDate, timeZone);
    }
    // Event deleted in Google Calendar meanwhile: a delete is done, an update becomes a create.
    if ((res.status === 404 || res.status === 410) && op.kind !== "create") {
      if (op.kind === "delete") {
        onDone(op, null);
        continue;
      }
      res = await request(token, { kind: "create", block: op.block }, isoDate, timeZone);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Google Calendar: ${body?.error?.message || res.statusText}`);
    }
    onDone(op, op.kind === "delete" ? null : (await res.json()).id);
  }
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
