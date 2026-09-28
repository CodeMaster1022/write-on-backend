/** Stored grade values: "K" for kindergarten, then "1" through "12". */
export const GRADES = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] as const;
export type Grade = (typeof GRADES)[number];

/**
 * Maps older free-text grades ("3rd", "Grade 5", "kindergarten") onto the
 * fixed list. Returns null for anything it can't read confidently.
 */
export function normalizeGrade(raw: string | null | undefined): Grade | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (text === "k" || text.startsWith("kinder")) return "K";

  const match = text.match(/\b(\d{1,2})(st|nd|rd|th)?\b/);
  if (!match) return null;
  const n = Number(match[1]);
  return n >= 1 && n <= 12 ? (String(n) as Grade) : null;
}

export const INKI_DAILY_LIMITS = { youngest: 5, middle: 10, oldest: 20 } as const;

/** K–2 → 5, 3–5 → 10, 6 and up → 20. No grade (including guests) gets the middle limit. */
export function inkiDailyLimit(gradeLevel: string | null | undefined): number {
  const grade = normalizeGrade(gradeLevel);
  if (grade === null) return INKI_DAILY_LIMITS.middle;
  const n = grade === "K" ? 0 : Number(grade);
  if (n <= 2) return INKI_DAILY_LIMITS.youngest;
  if (n <= 5) return INKI_DAILY_LIMITS.middle;
  return INKI_DAILY_LIMITS.oldest;
}
