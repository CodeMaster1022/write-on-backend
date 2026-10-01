import type { Types } from "mongoose";
import { ContestEntry } from "../models/Contest.js";
import { FEEDBACK_AREAS, FeedbackRun, type FeedbackArea, type IssueCategory } from "../models/FeedbackRun.js";
import { LessonAttempt } from "../models/Lesson.js";
import { Revision } from "../models/Revision.js";
import { Writing } from "../models/Writing.js";
import { weekStartKey } from "./time.js";

const MAX_DOCS = 5000;
const WEEKS_SHOWN = 8;
const MAX_WEEKS_BACK = 104;
const HISTORY_SHOWN = 8;
const RECENT_CHECKS_FOR_PRACTICE = 10;

export const GOAL_CHOICES = [1, 2, 3, 5, 7] as const;

const AREA_LABEL: Record<FeedbackArea, string> = { grammar: "Grammar", evidence: "Evidence", flow: "Flow" };

/** One short thing to practise, in the student's words. Keyed by the feedback's issue categories. */
const PRACTICE: Record<Exclude<IssueCategory, "other">, { label: string; tip: string }> = {
  capitalization: { label: "Capital letters", tip: "Start every sentence, and every name, with a capital letter." },
  punctuation: { label: "Punctuation", tip: "End each sentence with a period, question mark, or exclamation mark." },
  spelling: { label: "Spelling", tip: "Read your writing slowly, one word at a time, to catch spelling slips." },
  verb_tense: { label: "Verb tense", tip: "If your story happened in the past, keep your action words in the past too, like 'ran' and 'played'." },
  agreement: { label: "Matching words", tip: "One thing 'is', more than one thing 'are'. Check that your naming words and action words match." },
  run_on: { label: "Long sentences", tip: "When a sentence has lots of 'and then's, try splitting it into two sentences." },
  fragment: { label: "Complete sentences", tip: "Every sentence needs someone or something, and what they do." },
  word_choice: { label: "Word choice", tip: "Swap a plain word like 'good' or 'nice' for a more exact one." },
  needs_reason: { label: "Giving reasons", tip: "After you say what you think, add 'because' and your reason." },
  needs_example: { label: "Giving examples", tip: "Add 'for example' and one real example that shows what you mean." },
  unsupported_claim: { label: "Backing up ideas", tip: "For each big idea, add a fact or a detail that proves it." },
  off_topic: { label: "Staying on topic", tip: "Before you write each sentence, ask: does this help my main idea?" },
  needs_transition: { label: "Transition words", tip: "Link your ideas with words like 'first', 'next', 'also', and 'finally'." },
  order: { label: "Putting ideas in order", tip: "Tell things in the order they happened, or from most to least important." },
  repetition: { label: "Repeating words", tip: "If you use the same word a lot, try a different word that means the same thing." },
  sentence_variety: { label: "Starting sentences", tip: "Try starting a few sentences in a new way, like 'After lunch,' or 'Suddenly,'." },
};

export type GoalEntry = { weekStart: string; perWeek?: number | null };

interface ProgressUser {
  _id: Types.ObjectId;
  goalHistory?: ReadonlyArray<GoalEntry> | null;
  weeklyGoal?: number | null;
}

function addWeeks(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10);
}

/** The goal in force for a week: the latest entry that started on or before it. */
export function goalFor(history: ReadonlyArray<GoalEntry>, week: string): number | null {
  let goal: number | null = null;
  for (const entry of history) {
    if (entry.weekStart <= week) goal = entry.perWeek ?? null;
  }
  return goal;
}

export interface WeekResult {
  weekStart: string;
  pieces: number;
  minutes: number;
  goal: number | null;
  met: boolean;
}

export interface GoalSummary {
  perWeek: number | null;
  thisWeek: WeekResult;
  streak: { current: number; best: number };
  weeks: WeekResult[];
  /** Weeks with a goal in the last WEEKS_SHOWN (not counting this one), and how many were met. */
  recent: { withGoal: number; met: number };
}

/**
 * Weekly goal results, counted in the student's time zone. The current
 * streak counts this week once its goal is met; until then, the week still
 * in progress doesn't break it.
 */
export function summarizeGoal(
  writings: { createdAt: Date; activeSeconds?: number | null }[],
  history: ReadonlyArray<GoalEntry>,
  perWeek: number | null,
  tz: string,
  now = new Date(),
): GoalSummary {
  const thisWeek = weekStartKey(now, tz);
  const byWeek = new Map<string, { pieces: number; seconds: number }>();
  for (const w of writings) {
    const key = weekStartKey(w.createdAt, tz);
    const entry = byWeek.get(key) ?? { pieces: 0, seconds: 0 };
    entry.pieces += 1;
    entry.seconds += w.activeSeconds ?? 0;
    byWeek.set(key, entry);
  }

  const sorted = [...history].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const result = (week: string): WeekResult => {
    const stats = byWeek.get(week) ?? { pieces: 0, seconds: 0 };
    const goal = goalFor(sorted, week);
    return { weekStart: week, pieces: stats.pieces, minutes: Math.round(stats.seconds / 60), goal, met: goal !== null && stats.pieces >= goal };
  };

  // Every week from the first goal up to now, capped at two years.
  const firstGoalWeek = sorted[0]?.weekStart;
  const earliest = addWeeks(thisWeek, -MAX_WEEKS_BACK);
  const start = firstGoalWeek && firstGoalWeek > earliest ? firstGoalWeek : earliest;
  const weeks: WeekResult[] = [];
  if (firstGoalWeek) {
    for (let week = start; week <= thisWeek; week = addWeeks(week, 1)) weeks.push(result(week));
  }

  let best = 0;
  let run = 0;
  for (const w of weeks) {
    run = w.met ? run + 1 : 0;
    best = Math.max(best, run);
  }

  let current = 0;
  for (let i = weeks.length - 1; i >= 0; i--) {
    const w = weeks[i]!;
    if (w.met) current += 1;
    else if (w.weekStart === thisWeek) continue;
    else break;
  }

  const shown = Array.from({ length: WEEKS_SHOWN }, (_, i) => result(addWeeks(thisWeek, i - WEEKS_SHOWN + 1)));
  const past = shown.slice(0, -1).filter((w) => w.goal !== null);

  return {
    perWeek,
    thisWeek: result(thisWeek),
    streak: { current, best },
    weeks: shown,
    recent: { withGoal: past.length, met: past.filter((w) => w.met).length },
  };
}

export async function goalSummaryFor(user: ProgressUser, tz: string): Promise<GoalSummary> {
  const history = user.goalHistory ?? [];
  // A day of slack either side of each week covers every time zone.
  const firstGoalWeek = history.map((h) => h.weekStart).sort()[0];
  const shownFrom = Date.now() - (WEEKS_SHOWN + 1) * 7 * 86_400_000;
  const goalFrom = firstGoalWeek ? Date.parse(`${firstGoalWeek}T00:00:00Z`) - 86_400_000 : shownFrom;
  const since = new Date(Math.max(Math.min(goalFrom, shownFrom), Date.now() - (MAX_WEEKS_BACK + 1) * 7 * 86_400_000));
  const writings = await Writing.find({ userId: user._id, createdAt: { $gte: since } })
    .select("createdAt activeSeconds")
    .limit(MAX_DOCS)
    .lean();
  return summarizeGoal(writings, history, user.weeklyGoal ?? null, tz);
}

export interface Badge {
  key: string;
  title: string;
  description: string;
  earnedAt: Date | null;
  progress: { current: number; target: number } | null;
}

export async function buildProgress(user: ProgressUser, tz: string) {
  const [writings, runs, revisionCounts, firstEntry, goal, lessonsDone] = await Promise.all([
    Writing.find({ userId: user._id }).sort({ createdAt: 1 }).select("type wordCount createdAt").limit(MAX_DOCS).lean(),
    FeedbackRun.find({ userId: user._id }).sort({ createdAt: 1 }).select("ratings issues createdAt").limit(MAX_DOCS).lean(),
    Revision.aggregate<{ _id: unknown; n: number; second: Date }>([
      { $match: { userId: user._id } },
      { $sort: { createdAt: 1 } },
      { $group: { _id: "$writingId", n: { $sum: 1 }, dates: { $push: "$createdAt" } } },
      { $match: { n: { $gte: 2 } } },
      { $project: { n: 1, second: { $arrayElemAt: ["$dates", 1] } } },
    ]),
    ContestEntry.findOne({ userId: user._id }).sort({ createdAt: 1 }).select("createdAt").lean(),
    goalSummaryFor(user, tz),
    LessonAttempt.find({ userId: user._id }).sort({ createdAt: 1 }).select("createdAt").limit(MAX_DOCS).lean(),
  ]);

  // --- skills ---
  const skills = FEEDBACK_AREAS.map((area) => {
    const rated = runs.flatMap((r) => (typeof r.ratings?.[area] === "number" ? [{ rating: r.ratings[area] as number, date: r.createdAt }] : []));
    const recent = rated.slice(-HISTORY_SHOWN);
    const avg = (xs: { rating: number }[]) => (xs.length ? xs.reduce((s, x) => s + x.rating, 0) / xs.length : null);
    const recentAvg = avg(recent);
    const firstHalf = avg(recent.slice(0, Math.floor(recent.length / 2)));
    const secondHalf = avg(recent.slice(Math.floor(recent.length / 2)));
    let trend: "up" | "steady" | "down" | null = null;
    if (recent.length >= 4 && firstHalf !== null && secondHalf !== null) {
      const diff = secondHalf - firstHalf;
      trend = diff >= 0.4 ? "up" : diff <= -0.4 ? "down" : "steady";
    }
    return {
      area,
      label: AREA_LABEL[area],
      checks: rated.length,
      latest: rated.at(-1)?.rating ?? null,
      average: recentAvg === null ? null : Math.round(recentAvg * 10) / 10,
      trend,
      history: recent.map((r) => ({ rating: r.rating, date: r.date })),
    };
  });

  // --- next thing to practise: the most common problem in recent checks ---
  const counts = new Map<Exclude<IssueCategory, "other">, number>();
  for (const run of runs.slice(-RECENT_CHECKS_FOR_PRACTICE)) {
    for (const issue of run.issues ?? []) {
      if (issue.category === "other") continue;
      counts.set(issue.category, (counts.get(issue.category) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const practice = top ? { category: top[0], ...PRACTICE[top[0]], count: top[1] } : null;

  // --- badges ---
  const nth = (n: number) => writings[n - 1]?.createdAt ?? null;
  const firstOfType = (type: string) => writings.find((w) => w.type === type)?.createdAt ?? null;
  let words = 0;
  let thousandWordsAt: Date | null = null;
  for (const w of writings) {
    words += w.wordCount;
    if (!thousandWordsAt && words >= 1000) thousandWordsAt = w.createdAt;
  }
  // Every area that was rated got 3 stars (a sentence is only rated on grammar).
  const tripleStar = runs.find(
    (r) => r.ratings?.grammar === 3 && [r.ratings.evidence, r.ratings.flow].every((v) => v === null || v === undefined || v === 3),
  );
  const revisedAt = revisionCounts.map((r) => r.second).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

  const count = (current: number, target: number) => ({ current: Math.min(current, target), target });
  const badges: Badge[] = [
    { key: "first_piece", title: "First words", description: "Save your first piece of writing.", earnedAt: nth(1), progress: null },
    { key: "first_paragraph", title: "Paragraph maker", description: "Finish your first paragraph.", earnedAt: firstOfType("paragraph"), progress: null },
    { key: "first_essay", title: "Essay writer", description: "Finish your first essay.", earnedAt: firstOfType("essay"), progress: null },
    { key: "ten_pieces", title: "Ten pieces", description: "Save 10 pieces of writing.", earnedAt: nth(10), progress: count(writings.length, 10) },
    { key: "thousand_words", title: "Word explorer", description: "Write 1,000 words in all.", earnedAt: thousandWordsAt, progress: count(words, 1000) },
    { key: "reviser", title: "Reviser", description: "Save a better version of a piece you already wrote.", earnedAt: revisedAt, progress: null },
    { key: "triple_star", title: "Triple star", description: "Get 3 stars in every area on one AI check.", earnedAt: tripleStar?.createdAt ?? null, progress: null },
    {
      key: "streak_3",
      title: "On a roll",
      description: "Meet your weekly goal 3 weeks in a row.",
      earnedAt: goal.streak.best >= 3 ? new Date(0) : null,
      progress: count(goal.streak.best, 3),
    },
    { key: "contest", title: "Contest writer", description: "Enter a writing contest.", earnedAt: firstEntry?.createdAt ?? null, progress: null },
    { key: "first_lesson", title: "Lesson learner", description: "Finish a weekly lesson.", earnedAt: lessonsDone[0]?.createdAt ?? null, progress: null },
    { key: "five_lessons", title: "Lesson star", description: "Finish 5 weekly lessons.", earnedAt: lessonsDone[4]?.createdAt ?? null, progress: count(lessonsDone.length, 5) },
  ];

  return {
    totals: { pieces: writings.length, words, checks: runs.length },
    goal,
    skills,
    practice,
    badges: badges.map((b) => ({
      ...b,
      earned: b.earnedAt !== null,
      // The streak badge has no single moment it was earned.
      earnedAt: b.earnedAt && b.earnedAt.getTime() > 0 ? b.earnedAt : null,
      progress: b.earnedAt ? null : b.progress,
    })),
  };
}
