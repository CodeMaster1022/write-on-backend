import { gradeBand, type GradeBand } from "../config/grades.js";
import { Contest, contestStatus } from "../models/Contest.js";
import { FEEDBACK_AREAS, FeedbackRun, type IssueCategory } from "../models/FeedbackRun.js";
import { HelpEvent } from "../models/HelpEvent.js";
import { INKI_ELEMENTS, InkiQuestion, isInkiElement, type InkiElement } from "../models/InkiQuestion.js";
import { Lesson } from "../models/Lesson.js";
import { User } from "../models/User.js";
import { WRITING_TYPES, Writing } from "../models/Writing.js";
import { ELEMENT_LABEL, ISSUE_LABEL } from "./report.js";

const DAY = 24 * 60 * 60 * 1000;
export const ANALYTICS_PERIODS = [7, 30, 90] as const;

/** Real students: signed-up, non-admin accounts. (Old guest accounts, if any are left, are never counted.) */
const STUDENTS = { isGuest: false, isAdmin: false };

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

async function distinctActiveStudents(from: Date, to = new Date()): Promise<number> {
  const range = { createdAt: { $gte: from, $lt: to } };
  const [w, f, q] = await Promise.all([
    Writing.distinct("userId", range),
    FeedbackRun.distinct("userId", range),
    InkiQuestion.distinct("userId", range),
  ]);
  return new Set([...w, ...f, ...q].map(String)).size;
}

export interface AttentionItem {
  key: string;
  message: string;
  link: string;
}

export async function buildOverview() {
  const now = Date.now();
  const week = new Date(now - 7 * DAY);
  const prevWeek = new Date(now - 14 * DAY);

  const [
    students,
    unconfirmed,
    staleUnconfirmed,
    staleWaiting,
    newThisWeek,
    newLastWeek,
    pieces,
    piecesThisWeek,
    piecesLastWeek,
    checksThisWeek,
    checksLastWeek,
    inkiThisWeek,
    blockedThisWeek,
    activeThisWeek,
    activeLastWeek,
    contests,
    nextLesson,
    latestLesson,
  ] = await Promise.all([
    User.countDocuments(STUDENTS),
    User.countDocuments({ ...STUDENTS, emailVerified: false }),
    User.countDocuments({ ...STUDENTS, emailVerified: false, createdAt: { $lt: new Date(now - 3 * DAY) } }),
    User.countDocuments({ ...STUDENTS, role: "student", parentApprovedAt: null, createdAt: { $lt: new Date(now - 3 * DAY) } }),
    User.countDocuments({ ...STUDENTS, createdAt: { $gte: week } }),
    User.countDocuments({ ...STUDENTS, createdAt: { $gte: prevWeek, $lt: week } }),
    Writing.estimatedDocumentCount(),
    Writing.countDocuments({ createdAt: { $gte: week } }),
    Writing.countDocuments({ createdAt: { $gte: prevWeek, $lt: week } }),
    FeedbackRun.countDocuments({ createdAt: { $gte: week } }),
    FeedbackRun.countDocuments({ createdAt: { $gte: prevWeek, $lt: week } }),
    InkiQuestion.countDocuments({ createdAt: { $gte: week } }),
    InkiQuestion.countDocuments({ createdAt: { $gte: week }, blocked: true }),
    distinctActiveStudents(week),
    distinctActiveStudents(prevWeek, week),
    Contest.find().select("title startsAt endsAt announcedAt").lean(),
    Lesson.findOne({ startsAt: { $gt: new Date(now) } }).select("_id").lean(),
    Lesson.findOne({ startsAt: { $lte: new Date(now) } }).sort({ startsAt: -1 }).select("startsAt").lean(),
  ]);

  const byStatus = { upcoming: 0, open: 0, judging: 0, announced: 0 };
  for (const c of contests) byStatus[contestStatus(c)] += 1;

  const attention: AttentionItem[] = [];
  // Weekly lessons only work if there's always a next one. Nudge once this
  // week's lesson is a week old and nothing is scheduled to follow it.
  if (!nextLesson && (!latestLesson || now - latestLesson.startsAt.getTime() >= 7 * DAY)) {
    attention.push({
      key: "lesson",
      message: latestLesson ? "No lesson is scheduled for next week. Students are still seeing the last one." : "There's no weekly lesson yet. Write the first one.",
      link: "/app/admin/lessons",
    });
  }
  if (byStatus.judging > 0) {
    attention.push({
      key: "judging",
      message: `${byStatus.judging} ${byStatus.judging === 1 ? "contest has" : "contests have"} closed and ${
        byStatus.judging === 1 ? "is" : "are"
      } waiting for winners.`,
      link: "/app/admin/contests",
    });
  }
  if (staleWaiting > 0) {
    attention.push({
      key: "waiting",
      message: `${staleWaiting} ${staleWaiting === 1 ? "student is" : "students are"} still waiting for a parent to approve the account after 3 days.`,
      link: "/app/admin/users?filter=waiting",
    });
  }
  if (staleUnconfirmed > 0) {
    attention.push({
      key: "unconfirmed",
      message: `${staleUnconfirmed} ${staleUnconfirmed === 1 ? "student hasn't" : "students haven't"} confirmed their email after 3 days.`,
      link: "/app/admin/users?filter=unconfirmed",
    });
  }
  if (blockedThisWeek > 0) {
    attention.push({
      key: "blocked",
      message: `Inki's safety filter stopped ${blockedThisWeek} ${blockedThisWeek === 1 ? "question" : "questions"} this week.`,
      link: "/app/admin/analytics",
    });
  }

  return {
    totals: { students, unconfirmed, pieces },
    week: {
      newStudents: { now: newThisWeek, before: newLastWeek },
      pieces: { now: piecesThisWeek, before: piecesLastWeek },
      activeStudents: { now: activeThisWeek, before: activeLastWeek },
      aiChecks: { now: checksThisWeek, before: checksLastWeek },
      inkiQuestions: { now: inkiThisWeek },
    },
    contests: byStatus,
    attention,
  };
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface DayPoint {
  date: string;
  value: number;
}

const dayFormat = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });

/** Every day in the period, oldest first, in the admin's time zone. */
function dayKeys(days: number, tz: string): string[] {
  const fmt = dayFormat(tz);
  return Array.from({ length: days }, (_, i) => fmt.format(new Date(Date.now() - (days - 1 - i) * DAY)));
}

const dayOf = (tz: string) => ({ $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: tz } });

type Aggregator<R> = { aggregate: (pipeline: object[]) => Promise<R[]> };

async function perDay(model: Aggregator<{ _id: string; n: number }>, keys: string[], from: Date, tz: string, match: object = {}): Promise<DayPoint[]> {
  const rows = await model.aggregate([
    { $match: { createdAt: { $gte: from }, ...match } },
    { $group: { _id: dayOf(tz), n: { $sum: 1 } } },
  ]);
  const byDay = new Map(rows.map((r) => [r._id, r.n] as const));
  return keys.map((date) => ({ date, value: byDay.get(date) ?? 0 }));
}

async function activePerDay(keys: string[], from: Date, tz: string): Promise<DayPoint[]> {
  const pairs = (model: Aggregator<{ _id: { d: string; u: unknown } }>) =>
    model.aggregate([{ $match: { createdAt: { $gte: from } } }, { $group: { _id: { d: dayOf(tz), u: "$userId" } } }]);
  const [w, f, q] = await Promise.all([pairs(Writing as never), pairs(FeedbackRun as never), pairs(InkiQuestion as never)]);
  const usersPerDay = new Map<string, Set<string>>();
  for (const row of [...w, ...f, ...q]) {
    const set = usersPerDay.get(row._id.d) ?? new Set<string>();
    set.add(String(row._id.u));
    usersPerDay.set(row._id.d, set);
  }
  return keys.map((date) => ({ date, value: usersPerDay.get(date)?.size ?? 0 }));
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const percent = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 100));

export async function buildAnalytics(days: number, tz: string) {
  const from = new Date(Date.now() - days * DAY);
  const keys = dayKeys(days, tz);
  const range = { createdAt: { $gte: from } };

  const [signups, pieces, checks, inkiPerDay, active] = await Promise.all([
    perDay(User as never, keys, from, tz, STUDENTS),
    perDay(Writing as never, keys, from, tz),
    perDay(FeedbackRun as never, keys, from, tz),
    perDay(InkiQuestion as never, keys, from, tz),
    activePerDay(keys, from, tz),
  ]);

  const [writingByType, timed, runs, inkiRows, helpRows, allStudents, newStudents] = await Promise.all([
    Writing.aggregate<{ _id: string; n: number; words: number }>([
      { $match: range },
      { $group: { _id: "$type", n: { $sum: 1 }, words: { $sum: "$wordCount" } } },
    ]),
    Writing.aggregate<{ _id: null; avg: number; n: number }>([
      { $match: { ...range, activeSeconds: { $gt: 0 } } },
      { $group: { _id: null, avg: { $avg: "$activeSeconds" }, n: { $sum: 1 } } },
    ]),
    FeedbackRun.find(range).select("ratings issues").limit(20_000).lean(),
    InkiQuestion.find(range).select("kind element verdict blocked").limit(20_000).lean(),
    HelpEvent.aggregate<{ _id: string; n: number }>([{ $match: range }, { $group: { _id: "$kind", n: { $sum: 1 } } }]),
    User.find(STUDENTS).select("gradeLevel").lean(),
    User.find({ ...STUDENTS, createdAt: { $gte: from } }).select("_id").lean(),
  ]);

  // --- students by grade band ---
  const bands: Record<GradeBand | "none", number> = { youngest: 0, middle: 0, oldest: 0, none: 0 };
  for (const s of allStudents) bands[gradeBand(s.gradeLevel) ?? "none"] += 1;

  // --- feedback ---
  const ratingSums = Object.fromEntries(FEEDBACK_AREAS.map((a) => [a, { total: 0, n: 0 }])) as Record<string, { total: number; n: number }>;
  const issueCounts = new Map<IssueCategory, number>();
  for (const run of runs) {
    for (const area of FEEDBACK_AREAS) {
      const r = run.ratings?.[area];
      if (typeof r === "number") {
        ratingSums[area]!.total += r;
        ratingSums[area]!.n += 1;
      }
    }
    for (const issue of run.issues ?? []) {
      if (issue.category !== "other") issueCounts.set(issue.category, (issueCounts.get(issue.category) ?? 0) + 1);
    }
  }

  // --- Inki ---
  const checkStats = new Map<InkiElement, { total: number; notYet: number }>();
  let blocked = 0;
  let defines = 0;
  for (const q of inkiRows) {
    if (q.blocked) blocked += 1;
    if (q.kind === "define") defines += 1;
    if (q.kind === "check" && isInkiElement(q.element) && !q.blocked) {
      const e = checkStats.get(q.element) ?? { total: 0, notYet: 0 };
      e.total += 1;
      if (q.verdict === "not_yet") e.notYet += 1;
      checkStats.set(q.element, e);
    }
  }

  // --- do new students come back? ---
  const newIds = newStudents.map((s) => s._id);
  const theirWritings = newIds.length
    ? await Writing.find({ userId: { $in: newIds } }).select("userId createdAt").limit(50_000).lean()
    : [];
  const daysByUser = new Map<string, Set<string>>();
  const fmt = dayFormat(tz);
  for (const w of theirWritings) {
    const set = daysByUser.get(String(w.userId)) ?? new Set<string>();
    set.add(fmt.format(w.createdAt));
    daysByUser.set(String(w.userId), set);
  }
  const wroteAny = daysByUser.size;
  const wroteTwoDays = [...daysByUser.values()].filter((s) => s.size >= 2).length;

  return {
    period: { days, from: from.toISOString() },
    daily: { newStudents: signups, pieces, activeStudents: active, aiChecks: checks, inkiQuestions: inkiPerDay },
    writing: {
      byType: WRITING_TYPES.map((type) => {
        const row = writingByType.find((r) => r._id === type);
        return { type, pieces: row?.n ?? 0, words: row?.words ?? 0 };
      }),
      avgMinutes: timed[0] ? round1(timed[0].avg / 60) : null,
    },
    students: {
      total: allStudents.length,
      byBand: [
        { key: "youngest", label: "Kindergarten to 2nd", count: bands.youngest },
        { key: "middle", label: "3rd to 5th", count: bands.middle },
        { key: "oldest", label: "6th to 8th", count: bands.oldest },
        { key: "none", label: "No grade set", count: bands.none },
      ],
    },
    feedback: {
      checks: runs.length,
      avgRating: FEEDBACK_AREAS.map((area) => ({
        area,
        average: ratingSums[area]!.n ? round1(ratingSums[area]!.total / ratingSums[area]!.n) : null,
        checks: ratingSums[area]!.n,
      })),
      topIssues: [...issueCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([category, count]) => ({ label: ISSUE_LABEL[category], count })),
    },
    inki: {
      questions: inkiRows.length,
      defines,
      blocked,
      checks: INKI_ELEMENTS.filter((e) => checkStats.has(e)).map((e) => ({
        label: ELEMENT_LABEL[e],
        total: checkStats.get(e)!.total,
        notYetPercent: percent(checkStats.get(e)!.notYet, checkStats.get(e)!.total),
      })),
    },
    help: helpRows.map((r) => ({ kind: r._id, count: r.n })),
    engagement: {
      newStudents: newIds.length,
      wroteAny,
      wroteAnyPercent: percent(wroteAny, newIds.length),
      wroteTwoDays,
      wroteTwoDaysPercent: percent(wroteTwoDays, newIds.length),
    },
  };
}
