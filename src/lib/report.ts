import { createHash } from "node:crypto";
import type { Types } from "mongoose";
import { z } from "zod";
import { env } from "../config/env.js";
import { normalizeGrade } from "../config/grades.js";
import { FeedbackRun, type FeedbackArea, type IssueCategory } from "../models/FeedbackRun.js";
import { HelpEvent } from "../models/HelpEvent.js";
import { InkiQuestion, isInkiElement, type InkiElement } from "../models/InkiQuestion.js";
import { ReportSummary } from "../models/ReportShare.js";
import { WRITING_TYPES, Writing, type WritingType } from "../models/Writing.js";
import { chatJson } from "./openai.js";
import { goalSummaryFor, type GoalEntry, type GoalSummary } from "./progress.js";
import { weekStartKey } from "./time.js";

export const REPORT_PERIODS = [7, 30, 90] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

const MAX_DOCS = 2000;

export const TYPE_LABEL: Record<WritingType, string> = {
  sentence: "Sentences",
  paragraph: "Paragraphs",
  essay: "Essays",
};

const AREA_LABEL: Record<FeedbackArea, string> = {
  grammar: "Grammar",
  evidence: "Evidence",
  flow: "Flow",
};

export const ISSUE_LABEL: Record<IssueCategory, string> = {
  capitalization: "Capital letters",
  punctuation: "Punctuation",
  spelling: "Spelling",
  verb_tense: "Verb tense",
  agreement: "Subject–verb agreement",
  run_on: "Run-on sentences",
  fragment: "Incomplete sentences",
  word_choice: "Word choice",
  needs_reason: "Giving reasons",
  needs_example: "Giving examples",
  unsupported_claim: "Backing up claims",
  off_topic: "Staying on topic",
  needs_transition: "Transition words",
  order: "Putting ideas in order",
  repetition: "Repeating words",
  sentence_variety: "Varying how sentences start",
  other: "Other",
};

export const ELEMENT_LABEL: Record<InkiElement, string> = {
  answered_question: "Answering the question",
  evidence: "Using enough evidence",
  transitions: "Using transition words",
};

/** Worded the way the student asked it in helper Inki's dropdown. */
const CHECK_QUESTION: Record<InkiElement, string> = {
  answered_question: "Did I answer the question?",
  evidence: "Did I use enough evidence?",
  transitions: "Did I use transition words?",
};

const HELP_TOPIC_LABEL: Record<string, string> = {
  noun: "Help with nouns",
  verb: "Help with verbs",
  describing: "Help with describing words",
};

export type Trend = "improving" | "steady" | "slipping";

export interface Report {
  student: { displayName: string; grade: string | null };
  period: { days: number; from: string; to: string };
  generatedAt: string;
  time: {
    totalMinutes: number;
    timedPieces: number;
    avgMinutesByType: Partial<Record<WritingType, number>>;
    weekly: { weekStart: string; minutes: number; pieces: number }[];
  };
  activity: {
    totalPieces: number;
    totalWords: number;
    byType: { type: WritingType; label: string; pieces: number; avgWords: number }[];
    recent: { title: string; type: WritingType; date: string; words: number; minutes: number | null }[];
  };
  questions: {
    items: { label: string; count: number }[];
    inkiCount: number;
    helpCount: number;
  };
  focus: {
    analyses: number;
    areas: { area: FeedbackArea; label: string; avgRating: number | null; trend: Trend | null }[];
    topIssues: { label: string; count: number }[];
    inkiChecks: { label: string; total: number; notYet: number }[];
  };
  /** The student's weekly writing goal, if they ever set one. */
  goal: GoalSummary | null;
  summary: { overview: string; home: string[]; classroom: string[] } | null;
}

function gradeText(gradeLevel: string | null | undefined): string | null {
  const grade = normalizeGrade(gradeLevel);
  if (grade === null) return null;
  return grade === "K" ? "Kindergarten" : `Grade ${grade}`;
}

const minutes = (seconds: number) => Math.round(seconds / 60);
const round1 = (n: number) => Math.round(n * 10) / 10;
const average = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Compares the older half of the ratings with the newer half. Needs a few data points to say anything. */
function trendOf(ratingsOldestFirst: number[]): Trend | null {
  if (ratingsOldestFirst.length < 4) return null;
  const mid = Math.floor(ratingsOldestFirst.length / 2);
  const diff = average(ratingsOldestFirst.slice(mid))! - average(ratingsOldestFirst.slice(0, mid))!;
  if (diff >= 0.4) return "improving";
  if (diff <= -0.4) return "slipping";
  return "steady";
}

function titleOf(w: { title?: string | null; content: string }): string {
  const text = (w.title || w.content).replace(/\s+/g, " ").trim();
  return text.length > 70 ? `${text.slice(0, 67)}…` : text;
}

interface ReportUser {
  _id: Types.ObjectId;
  displayName: string;
  gradeLevel?: string | null;
  weeklyGoal?: number | null;
  goalHistory?: ReadonlyArray<GoalEntry> | null;
}

/** Everything in the report except the AI summary. */
export async function buildReport(user: ReportUser, periodDays: number, tz: string): Promise<Report> {
  const to = new Date();
  const from = new Date(to.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const range = { userId: user._id, createdAt: { $gte: from, $lte: to } };

  const [writings, runs, inki, help, goal] = await Promise.all([
    Writing.find(range).sort({ createdAt: -1 }).limit(MAX_DOCS).select("type title content wordCount activeSeconds createdAt").lean(),
    FeedbackRun.find(range).sort({ createdAt: 1 }).limit(MAX_DOCS).lean(),
    InkiQuestion.find({ ...range, blocked: false }).limit(MAX_DOCS).lean(),
    HelpEvent.find(range).limit(MAX_DOCS).lean(),
    user.goalHistory?.length ? goalSummaryFor(user, tz) : Promise.resolve(null),
  ]);

  // --- time ---
  const timed = writings.filter((w) => (w.activeSeconds ?? 0) > 0);
  const avgMinutesByType: Partial<Record<WritingType, number>> = {};
  for (const type of WRITING_TYPES) {
    const avg = average(timed.filter((w) => w.type === type).map((w) => w.activeSeconds));
    if (avg !== null) avgMinutesByType[type] = round1(avg / 60);
  }

  const weeks = new Map<string, { seconds: number; pieces: number }>();
  for (const w of writings) {
    const key = weekStartKey(w.createdAt, tz);
    const week = weeks.get(key) ?? { seconds: 0, pieces: 0 };
    week.seconds += w.activeSeconds ?? 0;
    week.pieces += 1;
    weeks.set(key, week);
  }

  // --- activity ---
  const byType = WRITING_TYPES.map((type) => {
    const ofType = writings.filter((w) => w.type === type);
    return {
      type,
      label: TYPE_LABEL[type],
      pieces: ofType.length,
      avgWords: Math.round(average(ofType.map((w) => w.wordCount)) ?? 0),
    };
  });

  // --- repeated questions (Inki + help buttons + word lookups, merged by topic) ---
  const counts = new Map<string, { label: string; count: number }>();
  const bump = (key: string, label: string) => {
    const entry = counts.get(key) ?? { label, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  };
  for (const q of inki) {
    if (q.kind === "define" && q.term) bump(`define:${q.term}`, `What "${q.term}" means`);
    if (q.kind === "check" && isInkiElement(q.element)) bump(`check:${q.element}`, CHECK_QUESTION[q.element]);
  }
  for (const h of help) {
    if (h.kind === "define") bump(`define:${h.topic}`, `What "${h.topic}" means`);
    else bump(`help:${h.topic}`, HELP_TOPIC_LABEL[h.topic] ?? `Help with ${h.topic}`);
  }
  const questionItems = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 8);

  // --- focus areas (from "Use AI to analyze" results) ---
  const areas = (["grammar", "evidence", "flow"] as const).map((area) => {
    const ratings = runs.map((r) => r.ratings?.[area]).filter((n): n is number => typeof n === "number");
    const avg = average(ratings);
    return { area, label: AREA_LABEL[area], avgRating: avg === null ? null : round1(avg), trend: trendOf(ratings) };
  });

  const issueCounts = new Map<IssueCategory, number>();
  for (const run of runs) {
    for (const issue of run.issues ?? []) {
      issueCounts.set(issue.category, (issueCounts.get(issue.category) ?? 0) + 1);
    }
  }
  const topIssues = [...issueCounts.entries()]
    .filter(([category]) => category !== "other")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([category, count]) => ({ label: ISSUE_LABEL[category], count }));

  const checks = new Map<InkiElement, { total: number; notYet: number }>();
  for (const q of inki) {
    if (q.kind !== "check" || !isInkiElement(q.element)) continue;
    const entry = checks.get(q.element) ?? { total: 0, notYet: 0 };
    entry.total += 1;
    if (q.verdict === "not_yet") entry.notYet += 1;
    checks.set(q.element, entry);
  }

  return {
    student: { displayName: user.displayName, grade: gradeText(user.gradeLevel) },
    period: { days: periodDays, from: from.toISOString(), to: to.toISOString() },
    generatedAt: to.toISOString(),
    time: {
      totalMinutes: minutes(writings.reduce((sum, w) => sum + (w.activeSeconds ?? 0), 0)),
      timedPieces: timed.length,
      avgMinutesByType,
      weekly: [...weeks.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([weekStart, v]) => ({ weekStart, minutes: minutes(v.seconds), pieces: v.pieces })),
    },
    activity: {
      totalPieces: writings.length,
      totalWords: writings.reduce((sum, w) => sum + w.wordCount, 0),
      byType,
      recent: writings.slice(0, 10).map((w) => ({
        title: titleOf(w),
        type: w.type,
        date: w.createdAt.toISOString(),
        words: w.wordCount,
        minutes: w.activeSeconds ? Math.max(1, minutes(w.activeSeconds)) : null,
      })),
    },
    questions: { items: questionItems, inkiCount: inki.length, helpCount: help.length },
    focus: {
      analyses: runs.length,
      areas,
      topIssues,
      inkiChecks: [...checks.entries()].map(([element, v]) => ({ label: ELEMENT_LABEL[element], ...v })),
    },
    goal,
    summary: null,
  };
}

// ---------------------------------------------------------------------------
// AI summary — written from the numbers only, never from the student's writing
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM = `You write short progress notes for parents and teachers about a K-12 student who uses Write on!, a guided writing app. You receive only numbers and category names, never the student's writing.

Return:
- "overview": 2-3 warm, plain-language sentences about what the student has been working on, one real strength, and one area to grow.
- "home": 2-3 short, concrete activities a parent or tutor can do at home in 5-10 minutes with no special materials.
- "classroom": 2-3 short, concrete ideas a teacher could use in lessons.

Rules:
- Base everything on the data given. Don't invent facts.
- Never diagnose or label the child, and never mention disabilities, disorders, or learning labels.
- Encouraging and specific. No jargon, grades, or scores. Say "your student", never a name.
- If there is very little data, say so gently and keep suggestions general.`;

const SUMMARY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "home", "classroom"],
  properties: {
    overview: { type: "string" },
    home: { type: "array", items: { type: "string" } },
    classroom: { type: "array", items: { type: "string" } },
  },
};

const summarySchema = z.object({
  overview: z.string().min(1).max(800),
  home: z.array(z.string().min(1).max(300)).min(1).max(4),
  classroom: z.array(z.string().min(1).max(300)).min(1).max(4),
});

/**
 * Adds the AI summary, reusing a cached one when the underlying numbers
 * haven't changed. Returns the report unchanged (summary: null) when AI
 * isn't configured, there's nothing to summarize, or the call fails, since
 * the rest of the report is still useful.
 */
export async function withSummary(user: ReportUser, report: Report): Promise<Report> {
  if (!env.OPENAI_API_KEY) return report;
  if (report.activity.totalPieces === 0 && report.focus.analyses === 0) return report;

  const input = {
    grade: report.student.grade ?? "unknown",
    periodDays: report.period.days,
    pieces: report.activity.byType.map(({ label, pieces, avgWords }) => ({ label, pieces, avgWords })),
    minutesWriting: report.time.totalMinutes,
    avgMinutesPerPiece: report.time.avgMinutesByType,
    feedbackAreas: report.focus.areas.map(({ label, avgRating, trend }) => ({ label, avgRatingOutOf3: avgRating, trend })),
    mostFlaggedIssues: report.focus.topIssues,
    inkiChecks: report.focus.inkiChecks,
    repeatedQuestions: report.questions.items.filter((q) => q.count > 1),
  };
  const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

  const cached = await ReportSummary.findOne({ userId: user._id, inputHash }).lean();
  if (cached) {
    return { ...report, summary: { overview: cached.overview, home: cached.home, classroom: cached.classroom } };
  }

  try {
    const raw = await chatJson(
      {
        system: SUMMARY_SYSTEM,
        user: JSON.stringify(input),
        schemaName: "progress_summary",
        schema: SUMMARY_JSON_SCHEMA,
        maxTokens: 600,
        failMessage: "summary unavailable",
      },
      "report",
    );
    const summary = summarySchema.parse(raw);
    await ReportSummary.updateOne(
      { userId: user._id, inputHash },
      { $setOnInsert: { ...summary } },
      { upsert: true },
    );
    return { ...report, summary };
  } catch (err) {
    console.error("[report] couldn't write the AI summary", err instanceof Error ? err.message : err);
    return report;
  }
}
