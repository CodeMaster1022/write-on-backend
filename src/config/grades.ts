/**
 * Stored grade values: "K" for kindergarten, then "1" through "8". Write on!
 * is for kindergarten to 8th grade; high school is a separate product.
 */
export const GRADES = ["K", "1", "2", "3", "4", "5", "6", "7", "8"] as const;
export type Grade = (typeof GRADES)[number];

const TOP_GRADE = 8;

/**
 * Maps older free-text grades ("3rd", "Grade 5", "kindergarten") onto the
 * fixed list. Returns null for anything it can't read confidently, including
 * grades above 8th that were saved before the app became K–8.
 */
export function normalizeGrade(raw: string | null | undefined): Grade | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (text === "k" || text.startsWith("kinder")) return "K";

  const match = text.match(/\b(\d{1,2})(st|nd|rd|th)?\b/);
  if (!match) return null;
  const n = Number(match[1]);
  return n >= 1 && n <= TOP_GRADE ? (String(n) as Grade) : null;
}

export type GradeBand = "youngest" | "middle" | "oldest";

/** K–2, 3–5, and 6–8 (grade 6 starts middle school). Null when there's no grade. */
export function gradeBand(gradeLevel: string | null | undefined): GradeBand | null {
  const grade = normalizeGrade(gradeLevel);
  if (grade === null) return null;
  const n = grade === "K" ? 0 : Number(grade);
  if (n <= 2) return "youngest";
  if (n <= 5) return "middle";
  return "oldest";
}

export const INKI_DAILY_LIMITS = { youngest: 5, middle: 10, oldest: 20 } as const;

/** K–2 → 5, 3–5 → 10, 6–8 → 20. No grade gets the middle limit. */
export function inkiDailyLimit(gradeLevel: string | null | undefined): number {
  return INKI_DAILY_LIMITS[gradeBand(gradeLevel) ?? "middle"];
}

/**
 * Word bank tiers in the order a grade band should see them. The youngest
 * writers skip the hardest words; the oldest see the hardest words first.
 * Grades 3–5 and students with no grade keep the original easiest-first list.
 */
export function wordTiersFor(gradeLevel: string | null | undefined): number[] {
  const band = gradeBand(gradeLevel);
  if (band === "youngest") return [1, 2];
  if (band === "oldest") return [3, 2, 1];
  return [1, 2, 3];
}
