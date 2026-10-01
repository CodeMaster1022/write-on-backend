import { Router } from "express";
import { z } from "zod";
import { gradeBand, normalizeGrade } from "../config/grades.js";
import { deleteAccountData } from "../lib/account.js";
import { ANALYTICS_PERIODS, buildAnalytics, buildOverview } from "../lib/admin-stats.js";
import { logAdminAction } from "../lib/audit.js";
import { sendPasswordReset } from "../lib/password-reset.js";
import { timeZoneOf } from "../lib/time.js";
import { sendVerificationEmail } from "../lib/verification.js";
import { sendParentApprovalEmail } from "../lib/parent-approval.js";
import { ensureFamily, planFor } from "../lib/plan.js";
import { Family, planOf } from "../models/Family.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { AdminAction } from "../models/AdminAction.js";
import { ContestEntry } from "../models/Contest.js";
import { FeedbackRun } from "../models/FeedbackRun.js";
import { InkiQuestion } from "../models/InkiQuestion.js";
import { User, parentApproved } from "../models/User.js";
import { Writing } from "../models/Writing.js";

/**
 * The admin dashboard: overview, analytics, users and the activity log.
 * Admins see counts, names, grades and emails, never a student's writing
 * (the contest judge reads entries in the contests routes, and that's all).
 */
export const adminUsersRouter = Router();

adminUsersRouter.use(requireAuth, requireAdmin);

const DAY = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 25;
const objectId = z.string().regex(/^[a-f0-9]{24}$/);

adminUsersRouter.get("/overview", async (_req, res) => {
  res.json(await buildOverview());
});

adminUsersRouter.get("/analytics", async (req, res) => {
  const { days } = z
    .object({
      days: z.coerce
        .number()
        .int()
        .refine((n) => (ANALYTICS_PERIODS as readonly number[]).includes(n), "Pick 7, 30, or 90 days.")
        .default(30),
    })
    .parse(req.query);
  res.json(await buildAnalytics(days, timeZoneOf(req)));
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const FILTERS = ["students", "waiting", "unconfirmed", "inactive", "all"] as const;

const listSchema = z.object({
  q: z.string().trim().max(60).optional(),
  filter: z.enum(FILTERS).default("students"),
  page: z.coerce.number().int().min(1).default(1),
});

function filterQuery(filter: (typeof FILTERS)[number]): Record<string, unknown> {
  const monthAgo = new Date(Date.now() - 30 * DAY);
  switch (filter) {
    case "students":
      return { isGuest: false, isAdmin: false };
    case "waiting":
      return { isGuest: false, isAdmin: false, role: "student", parentApprovedAt: null };
    case "unconfirmed":
      return { isGuest: false, isAdmin: false, emailVerified: false };
    case "inactive":
      return {
        isGuest: false,
        isAdmin: false,
        createdAt: { $lt: monthAgo },
        $or: [{ lastWroteAt: null }, { lastWroteAt: { $lt: monthAgo } }],
      };
    case "all":
      return { isGuest: false };
  }
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function listedUser(u: {
  _id: unknown;
  displayName: string;
  email?: string | null;
  gradeLevel?: string | null;
  isAdmin?: boolean;
  role?: "student" | "teacher";
  emailVerified?: boolean;
  parentEmail?: string | null;
  parentApprovedAt?: Date | null;
  writingCount: number;
  lastWroteAt?: Date | null;
  createdAt: Date;
}) {
  return {
    id: String(u._id),
    name: u.displayName,
    email: u.email ?? null,
    grade: normalizeGrade(u.gradeLevel),
    isAdmin: u.isAdmin ?? false,
    emailConfirmed: u.emailVerified ?? true,
    parentEmail: u.parentEmail ?? null,
    parentApproved: parentApproved({ parentApprovedAt: u.parentApprovedAt ?? null, isAdmin: u.isAdmin ?? false, role: u.role ?? "student" }),
    pieces: u.writingCount,
    lastWroteAt: u.lastWroteAt ?? null,
    joined: u.createdAt,
  };
}

adminUsersRouter.get("/users", async (req, res) => {
  const { q, filter, page } = listSchema.parse(req.query);
  const query: Record<string, unknown> = { ...filterQuery(filter) };
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    const search = [{ displayName: rx }, { email: rx }];
    query.$and = [{ $or: search }];
  }

  const [total, users] = await Promise.all([
    User.countDocuments(query),
    User.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .select("displayName email gradeLevel isAdmin role emailVerified parentEmail parentApprovedAt writingCount lastWroteAt createdAt")
      .lean(),
  ]);

  // The plan is per family (parent email), so look the families up once for the page.
  const parentEmails = [...new Set(users.flatMap((u) => (u.parentEmail ? [u.parentEmail] : [])))];
  const families = parentEmails.length ? await Family.find({ parentEmail: { $in: parentEmails } }).lean() : [];
  const familyByEmail = new Map(families.map((f) => [f.parentEmail, f]));
  const planFor = (u: (typeof users)[number]) =>
    u.isAdmin || u.role === "teacher" ? "premium" : planOf(u.parentEmail ? (familyByEmail.get(u.parentEmail) ?? null) : null).plan;

  res.json({ total, page, pageSize: PAGE_SIZE, users: users.map((u) => ({ ...listedUser(u), plan: planFor(u) })) });
});

async function requireUser(raw: unknown) {
  const parsed = objectId.safeParse(raw);
  const user = parsed.success ? await User.findById(parsed.data) : null;
  if (!user) throw new HttpError(404, "We couldn't find that account.");
  return user;
}

/** Counts about one account. Never the writing itself. */
adminUsersRouter.get("/users/:id", async (req, res) => {
  const user = await requireUser(req.params.id);
  const [feedbackChecks, inkiQuestions, contestEntries, totals] = await Promise.all([
    FeedbackRun.countDocuments({ userId: user._id }),
    InkiQuestion.countDocuments({ userId: user._id }),
    ContestEntry.countDocuments({ userId: user._id }),
    Writing.aggregate<{ _id: null; words: number; seconds: number }>([
      { $match: { userId: user._id } },
      { $group: { _id: null, words: { $sum: "$wordCount" }, seconds: { $sum: "$activeSeconds" } } },
    ]),
  ]);

  const plan = await planFor(user);
  const family = user.parentEmail ? await Family.findOne({ parentEmail: user.parentEmail }).lean() : null;

  res.json({
    user: {
      ...listedUser(user),
      role: user.role,
      band: gradeBand(user.gradeLevel),
      inkDrops: user.inkDrops,
      weeklyGoal: user.weeklyGoal ?? null,
      plan: { ...plan, compNote: family?.compNote ?? "", trialEndsAt: family?.trialEndsAt ?? null },
    },
    counts: {
      pieces: user.writingCount,
      words: totals[0]?.words ?? 0,
      minutes: Math.round((totals[0]?.seconds ?? 0) / 60),
      feedbackChecks,
      inkiQuestions,
      contestEntries,
    },
  });
});

adminUsersRouter.post("/users/:id/resend-confirmation", async (req, res) => {
  const user = await requireUser(req.params.id);
  if (!user.email) throw new HttpError(400, "This account has no email to confirm.");
  if (user.emailVerified !== false) throw new HttpError(400, "This email is already confirmed.");

  const result = await sendVerificationEmail(user);
  if (result === "limit") throw new HttpError(429, "3 confirmation emails were already sent to this account today.");
  if (result === "failed") throw new HttpError(502, "Couldn't send the email right now. Please try again in a few minutes.");

  await logAdminAction(req.user!._id, "user_resend_confirmation", { targetUserId: user._id });
  res.json({ ok: true });
});

adminUsersRouter.post("/users/:id/resend-parent-approval", async (req, res) => {
  const user = await requireUser(req.params.id);
  if (parentApproved(user)) throw new HttpError(400, "This account is already approved.");
  if (!user.parentEmail) throw new HttpError(400, "This account has no parent email yet. The student adds one on their account page.");

  const result = await sendParentApprovalEmail(user);
  if (result === "limit") throw new HttpError(429, "3 approval emails were already sent to the parent today.");
  if (result === "failed") throw new HttpError(502, "Couldn't send the email right now. Please try again in a few minutes.");

  await logAdminAction(req.user!._id, "user_resend_parent_approval", { targetUserId: user._id });
  res.json({ ok: true });
});

const compSchema = z.object({
  /** Months of free Premium, "forever", or "none" to take a comp away. */
  months: z.union([z.number().int().min(1).max(120), z.literal("forever"), z.literal("none")]),
  note: z.string().trim().max(120).default(""),
});

/** Gives a family Premium without paying (a tutor, a friend, a support case). Covers every child with that parent email. */
adminUsersRouter.post("/users/:id/comp", async (req, res) => {
  const { months, note } = compSchema.parse(req.body);
  const user = await requireUser(req.params.id);
  if (!user.parentEmail) throw new HttpError(400, "This account has no parent email, so there's no family to give Premium to.");

  const family = await ensureFamily(user.parentEmail);
  family.compUntil = months === "none" ? null : months === "forever" ? new Date("2999-01-01") : new Date(Date.now() + months * 30 * DAY);
  family.compNote = months === "none" ? "" : note;
  await family.save();

  const what = months === "none" ? "took free Premium away" : months === "forever" ? "free Premium, no end date" : `free Premium for ${months} ${months === 1 ? "month" : "months"}`;
  await logAdminAction(req.user!._id, "user_comp", { targetUserId: user._id, note: what });
  res.json({ ok: true, plan: planOf(family) });
});

adminUsersRouter.post("/users/:id/password-reset", async (req, res) => {
  const user = await requireUser(req.params.id);
  const result = await sendPasswordReset(user);

  if (result === "no_email") throw new HttpError(400, "This account has no email, so there's no password to reset.");
  if (result === "unconfirmed") {
    throw new HttpError(400, "This email isn't confirmed yet, so no reset link was sent. Send the confirmation email first.");
  }
  if (result === "limit") throw new HttpError(429, "3 reset emails were already sent to this address today.");

  await logAdminAction(req.user!._id, "user_reset_password", { targetUserId: user._id });
  res.json({ ok: true });
});

const deleteSchema = z.object({ confirmName: z.string().trim().max(60) });

/** Deletes the account and everything saved for it. The admin must type the student's name to confirm. */
adminUsersRouter.delete("/users/:id", async (req, res) => {
  const { confirmName } = deleteSchema.parse(req.body ?? {});
  const user = await requireUser(req.params.id);

  if (user.isAdmin) throw new HttpError(400, "Admin accounts can't be deleted here.");
  if (String(user._id) === String(req.user!._id)) throw new HttpError(400, "You can't delete your own account here.");
  if (confirmName.toLowerCase() !== user.displayName.trim().toLowerCase()) {
    throw new HttpError(400, "That doesn't match the student's name. Nothing was deleted.");
  }

  const grade = normalizeGrade(user.gradeLevel);
  const note = `${grade ? (grade === "K" ? "Kindergarten" : `Grade ${grade}`) : "No grade"} student, ${user.writingCount} ${user.writingCount === 1 ? "piece" : "pieces"}`;
  await deleteAccountData(user._id);
  await logAdminAction(req.user!._id, "user_delete", { targetUserId: user._id, note });

  console.log(`[admin] account deleted (${String(user._id)})`);
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

adminUsersRouter.get("/activity", async (req, res) => {
  const { page } = z.object({ page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  const [total, actions] = await Promise.all([
    AdminAction.countDocuments(),
    AdminAction.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean(),
  ]);

  const ids = [...new Set([...actions.map((a) => String(a.adminId)), ...actions.flatMap((a) => (a.targetUserId ? [String(a.targetUserId)] : []))])];
  const people = await User.find({ _id: { $in: ids } }).select("displayName").lean();
  const nameOf = new Map(people.map((p) => [String(p._id), p.displayName]));

  res.json({
    total,
    page,
    pageSize: PAGE_SIZE,
    actions: actions.map((a) => ({
      id: String(a._id),
      kind: a.kind,
      when: a.createdAt,
      admin: nameOf.get(String(a.adminId)) ?? "An admin",
      // Null once the account has been deleted.
      student: a.targetUserId ? (nameOf.get(String(a.targetUserId)) ?? null) : null,
      hasStudent: a.targetUserId !== null,
      contest: a.contestTitle,
      lesson: a.lessonTitle,
      note: a.note,
    })),
  });
});

