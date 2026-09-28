import type { Request } from "express";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The student's time zone from the X-Timezone header the client sends, or UTC. */
export function timeZoneOf(req: Request): string {
  const header = req.get("x-timezone") ?? "";
  return header && isValidTimeZone(header) ? header : "UTC";
}

function wallClock(date: Date, tz: string) {
  const parts: Record<string, string> = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const n = (key: string) => Number(parts[key]);
  return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour"), minute: n("minute"), second: n("second") };
}

/** Midnight today in `tz`, so a daily limit resets at the student's own midnight. */
export function startOfToday(tz: string, now = new Date()): Date {
  const w = wallClock(now, tz);
  const wallClockAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const offsetMs = wallClockAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(w.year, w.month - 1, w.day) - offsetMs);
}

/** "YYYY-MM-DD" of the Monday starting the week that `date` falls in, in `tz`. */
export function weekStartKey(date: Date, tz: string): string {
  const w = wallClock(date, tz);
  const local = new Date(Date.UTC(w.year, w.month - 1, w.day));
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  local.setUTCDate(local.getUTCDate() - daysSinceMonday);
  return local.toISOString().slice(0, 10);
}
