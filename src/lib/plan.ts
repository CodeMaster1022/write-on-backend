import type { Request } from "express";
import { HttpError } from "../middleware/error.js";
import { Family, TRIAL_DAYS, planOf, type PlanInfo } from "../models/Family.js";
import { FeedbackRun } from "../models/FeedbackRun.js";
import { InkiQuestion } from "../models/InkiQuestion.js";
import type { UserDoc } from "../models/User.js";
import { startOfToday, weekStartKey } from "./time.js";

/**
 * Free is a complete writing app; Premium is the tutor. Everything that costs
 * money per use (OpenAI, Deepgram) is Premium, with a small weekly taste on the
 * free plan so a child can see what the AI help is before a parent pays.
 */
export const FREE_WEEKLY = { aiChecks: 3, inkiQuestions: 3 } as const;

export const PREMIUM_CODE = "premium_needed";
export type PremiumFeature = "ai_feedback" | "inki" | "voice_typing" | "report";

const FEATURE_MESSAGE: Record<PremiumFeature, string> = {
  ai_feedback: "You've used this week's free AI checks. AI feedback any time is part of Premium — ask a parent?",
  inki: "You've used this week's free questions for Inki. Asking Inki any time is part of Premium — ask a parent?",
  voice_typing: "Voice typing is part of Premium — ask a parent? You can type for now.",
  report: "The written summary, Word file, email and share links are part of Premium — ask a parent? The numbers are free.",
};

/** The family record for a parent email, created with a fresh trial the first time it's needed. */
export async function ensureFamily(parentEmail: string) {
  const email = parentEmail.trim().toLowerCase();
  return Family.findOneAndUpdate(
    { parentEmail: email },
    { $setOnInsert: { parentEmail: email, trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000) } },
    { upsert: true, new: true },
  );
}

/** What this account can use. Admins and teachers are grown-ups and always Premium. */
export async function planFor(user: Pick<UserDoc, "parentEmail" | "isAdmin" | "role" | "parentApprovedAt">): Promise<PlanInfo> {
  if (user.isAdmin || user.role === "teacher") return { plan: "premium", reason: "admin", until: null, cancelAtPeriodEnd: false, hasBilling: false };
  if (!user.parentEmail) return planOf(null);
  // An approved account always has a family; the trial starts at approval.
  const family = user.parentApprovedAt ? await ensureFamily(user.parentEmail) : await Family.findOne({ parentEmail: user.parentEmail }).lean();
  return planOf(family);
}

const DAY = 24 * 60 * 60 * 1000;

/** Monday 00:00 in the student's time zone (to the hour across a clock change), for the weekly free allowance. */
function startOfWeek(tz: string): Date {
  const now = new Date();
  const monday = weekStartKey(now, tz);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const daysSinceMonday = Math.round((Date.parse(today) - Date.parse(monday)) / DAY);
  return new Date(startOfToday(tz, now).getTime() - daysSinceMonday * DAY);
}

export async function freeLeft(user: UserDoc, tz: string): Promise<{ aiChecks: number; inkiQuestions: number }> {
  const since = startOfWeek(tz);
  const [checks, questions] = await Promise.all([
    FeedbackRun.countDocuments({ userId: user._id, createdAt: { $gte: since } }),
    InkiQuestion.countDocuments({ userId: user._id, createdAt: { $gte: since } }),
  ]);
  return { aiChecks: Math.max(0, FREE_WEEKLY.aiChecks - checks), inkiQuestions: Math.max(0, FREE_WEEKLY.inkiQuestions - questions) };
}

function premiumError(feature: PremiumFeature, extra: Record<string, unknown> = {}) {
  return new HttpError(402, FEATURE_MESSAGE[feature], { code: PREMIUM_CODE, feature, ...extra });
}

/** Premium only: no free taste. */
export async function requirePremium(req: Request, feature: PremiumFeature): Promise<PlanInfo> {
  const plan = await planFor(req.user!);
  if (plan.plan !== "premium") throw premiumError(feature);
  return plan;
}

/** Premium, or one of this week's free uses. Returns how many free uses are left for the reply. */
export async function requirePremiumOrFreeUse(req: Request, feature: "ai_feedback" | "inki", tz: string): Promise<{ plan: PlanInfo; freeLeft: number | null }> {
  const plan = await planFor(req.user!);
  if (plan.plan === "premium") return { plan, freeLeft: null };
  const left = await freeLeft(req.user!, tz);
  const remaining = feature === "ai_feedback" ? left.aiChecks : left.inkiQuestions;
  if (remaining <= 0) throw premiumError(feature, { freeLeft: 0 });
  return { plan, freeLeft: remaining };
}
