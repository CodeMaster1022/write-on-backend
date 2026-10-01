import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { loginLimiter } from "../middleware/rate-limit.js";
import { z } from "zod";
import { GRADES } from "../config/grades.js";
import { deleteAccountData } from "../lib/account.js";
import { sendPasswordReset } from "../lib/password-reset.js";
import { EmailLog, EmailVerification, PasswordReset } from "../models/PasswordReset.js";
import { sendVerificationEmail, claimVerificationLink } from "../lib/verification.js";
import { claimParentLink, sendParentApprovalEmail } from "../lib/parent-approval.js";
import { ensureFamily, planFor } from "../lib/plan.js";
import { Contest, ContestEntry } from "../models/Contest.js";
import { FeedbackRun } from "../models/FeedbackRun.js";
import { HelpEvent } from "../models/HelpEvent.js";
import { InkiQuestion } from "../models/InkiQuestion.js";
import { ReportEmail, ReportShare, ReportSummary } from "../models/ReportShare.js";
import { Revision } from "../models/Revision.js";
import { User, hashPassword, publicUser } from "../models/User.js";
import { Writing } from "../models/Writing.js";
import { requireAuth, signToken } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";

export const authRouter = Router();

const registerSchema = z.object({
  displayName: z.string().trim().min(1, "Tell us your name.").max(60),
  email: z.string().trim().toLowerCase().email("That email doesn't look right."),
  password: z.string().min(8, "Use at least 8 characters."),
  parentEmail: z.string().trim().toLowerCase().email("Your parent's email doesn't look right.").max(160),
  gradeLevel: z.enum(GRADES).optional(),
  classCode: z.string().trim().toUpperCase().max(12).optional(),
});

authRouter.post("/register", async (req, res) => {
  const body = registerSchema.parse(req.body);

  const existing = await User.findOne({ email: body.email });
  if (existing) throw new HttpError(409, "An account already uses that email.");

  const user = await User.create({
    displayName: body.displayName,
    email: body.email,
    passwordHash: await hashPassword(body.password),
    // Teacher accounts aren't self-serve: a teacher role can read every
    // student sharing a class code, so it's only granted by hand.
    role: "student",
    gradeLevel: body.gradeLevel,
    classCode: body.classCode,
    parentEmail: body.parentEmail,
    isGuest: false,
    emailVerified: false,
  });

  // The account is paused until the parent approves. The student's own email only has to be confirmed before the app sends them email.
  const [parentApprovalEmail, verificationEmail] = await Promise.all([sendParentApprovalEmail(user), sendVerificationEmail(user)]);

  res.status(201).json({
    token: signToken({ sub: user.id, role: user.role, v: user.sessionVersion ?? 0 }),
    user: publicUser(user),
    parentApprovalEmail,
    verificationEmail,
  });
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("That email doesn't look right."),
  password: z.string().min(1, "Enter your password."),
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const body = loginSchema.parse(req.body);

  // Logs carry the account ID only, never the email address.
  const user = await User.findOne({ email: body.email }).select("+passwordHash");
  if (!user || !(await user.verifyPassword(body.password))) {
    console.log(`[auth] login failed (${user ? `account ${user.id}` : "no matching account"})`);
    throw new HttpError(401, "We couldn't match that email and password.");
  }

  console.log(`[auth] login succeeded (account ${user.id})`);

  res.json({
    token: signToken({ sub: user.id, role: user.role, v: user.sessionVersion ?? 0 }),
    user: publicUser(user),
  });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  res.json({ user: publicUser(req.user!) });
});

const updateMeSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  gradeLevel: z.enum(GRADES).nullable().optional(),
  classCode: z.string().trim().toUpperCase().max(12).nullable().optional(),
  /** Only while the account is still waiting for approval: a wrong address can be fixed, and accounts from before approval existed can add one. */
  parentEmail: z.string().trim().toLowerCase().email("Your parent's email doesn't look right.").max(160).optional(),
  emailLessons: z.boolean().optional(),
});

authRouter.patch("/me", requireAuth, async (req, res) => {
  const body = updateMeSchema.parse(req.body);
  const user = req.user!;

  if (body.displayName !== undefined) user.displayName = body.displayName;
  if (body.gradeLevel !== undefined) user.gradeLevel = body.gradeLevel ?? undefined;
  if (body.classCode !== undefined) user.classCode = body.classCode ?? undefined;
  if (body.emailLessons !== undefined) user.emailLessons = body.emailLessons;

  let parentApprovalEmail: string | undefined;
  if (body.parentEmail !== undefined) {
    if (user.parentApprovedAt) throw new HttpError(400, "A parent has already approved this account, so the parent's email can't be changed here.");
    user.parentEmail = body.parentEmail;
    await user.save();
    parentApprovalEmail = await sendParentApprovalEmail(user);
    if (parentApprovalEmail === "limit") {
      throw new HttpError(429, "We've emailed your parent 3 times today. Ask them to check their inbox and spam folder, or try again tomorrow.");
    }
  }

  await user.save();
  res.json({ user: publicUser(user), ...(parentApprovalEmail ? { parentApprovalEmail } : {}) });
});

// ---------------------------------------------------------------------------
// Parent approval
// ---------------------------------------------------------------------------

const parentChoiceSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "This link isn't valid. Ask the student to send a new one from the app."),
  approve: z.boolean(),
});

const PARENT_LINK_GONE = "This link has expired or was already used. The student can send a new one from the app.";

const parentLinkLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new HttpError(429, "Too many tries. Please wait a few minutes and try again.")),
});

/** Opened by the parent from their email; no sign-in. Approving unpauses the account; saying no deletes it. */
authRouter.post("/parent-approval", parentLinkLimiter, async (req, res) => {
  const { token, approve } = parentChoiceSchema.parse(req.body);
  const link = await claimParentLink(token);
  const user = link ? await User.findById(link.userId) : null;
  // The link only speaks for the address it was sent to.
  if (!link || !user || user.parentEmail !== link.parentEmail) throw new HttpError(400, PARENT_LINK_GONE);

  if (!approve) {
    await deleteAccountData(user._id);
    console.log(`[auth] account deleted by parent (${user.id})`);
    res.json({ ok: true, approved: false, studentName: user.displayName });
    return;
  }

  if (!user.parentApprovedAt) {
    user.parentApprovedAt = new Date();
    await user.save();
  }
  // The family's 14-day Premium trial starts with the first approval.
  await ensureFamily(user.parentEmail!);
  console.log(`[auth] parent approved account ${user.id}`);
  res.json({ ok: true, approved: true, studentName: user.displayName });
});

authRouter.post("/resend-parent-approval", requireAuth, async (req, res) => {
  const result = await sendParentApprovalEmail(req.user!);
  if (result === "limit") {
    throw new HttpError(429, "We've emailed your parent 3 times today. Ask them to check their inbox and spam folder, or try again tomorrow.");
  }
  if (result === "failed") throw new HttpError(502, "Couldn't send the email right now. Please try again in a few minutes.");
  res.json({ result, user: publicUser(req.user!) });
});

/** Everything saved about this student, as one file the family can keep. */
authRouter.get("/me/export", requireAuth, async (req, res) => {
  const user = req.user!;
  const userId = user._id;

  const [writings, revisions, feedback, inkiQuestions, helpEvents, entries, shares] = await Promise.all([
    Writing.find({ userId }).sort({ createdAt: 1 }).lean(),
    Revision.find({ userId }).sort({ createdAt: 1 }).lean(),
    FeedbackRun.find({ userId }).sort({ createdAt: 1 }).lean(),
    InkiQuestion.find({ userId }).sort({ createdAt: 1 }).lean(),
    HelpEvent.find({ userId }).sort({ createdAt: 1 }).lean(),
    ContestEntry.find({ userId }).sort({ createdAt: 1 }).lean(),
    ReportShare.find({ userId }).sort({ createdAt: 1 }).lean(),
  ]);
  const contests = await Contest.find({ _id: { $in: entries.map((e) => e.contestId) } })
    .select("title announcedAt")
    .lean();
  const contestById = new Map(contests.map((c) => [String(c._id), c]));

  const data = {
    exportedAt: new Date(),
    profile: {
      name: user.displayName,
      email: user.email ?? null,
      parentEmail: user.parentEmail ?? null,
      parentApproved: user.parentApprovedAt ?? null,
      plan: await planFor(user),
      grade: user.gradeLevel ?? null,
      accountType: user.role,
      joined: user.createdAt,
      inkDrops: user.inkDrops,
      closetItems: user.ownedItems,
      weeklyGoal: user.weeklyGoal ?? null,
      goalHistory: user.goalHistory ?? [],
      wearing: publicUser(user).equipped,
    },
    writing: writings.map((w) => ({
      id: String(w._id),
      type: w.type,
      title: w.title,
      content: w.content,
      answers: w.parts,
      wordCount: w.wordCount,
      inkDropsEarned: w.inkDropsEarned,
      activeSeconds: w.activeSeconds,
      written: w.createdAt,
      lastChanged: w.updatedAt,
      earlierVersions: revisions
        .filter((r) => String(r.writingId) === String(w._id))
        .map((r) => ({ content: r.content, wordCount: r.wordCount, saved: r.createdAt })),
    })),
    aiFeedback: feedback.map((f) => ({
      writingId: f.writingId ? String(f.writingId) : null,
      writingType: f.writingType,
      ratings: f.ratings,
      issues: f.issues,
      date: f.createdAt,
    })),
    inkiQuestions: inkiQuestions.map(({ _id, __v, userId: _owner, ...rest }) => rest),
    helpUsed: helpEvents.map(({ _id, __v, userId: _owner, ...rest }) => rest),
    contestEntries: entries.map((e) => {
      const contest = contestById.get(String(e.contestId));
      return {
        contest: contest?.title ?? null,
        writingId: String(e.writingId),
        entered: e.updatedAt,
        // Winners stay private until they're announced.
        winner: contest?.announcedAt ? e.isWinner : null,
      };
    }),
    reportLinks: shares.map((s) => ({
      periodDays: s.periodDays,
      created: s.createdAt,
      expires: s.expiresAt,
      turnedOff: s.revokedAt,
    })),
  };

  res.setHeader("Content-Disposition", 'attachment; filename="write-on-my-data.json"');
  res.setHeader("Cache-Control", "no-store");
  res.json(data);
});

const deleteMeSchema = z.object({ password: z.string().min(1, "Type your password to confirm.") });

/** Deletes the account and everything saved for it. This can't be undone. */
authRouter.delete("/me", requireAuth, async (req, res) => {
  const body = deleteMeSchema.parse(req.body ?? {});
  const userId = req.user!._id;

  const user = await User.findById(userId).select("+passwordHash");
  if (!user) throw new HttpError(404, "We couldn't find that account.");
  if (user.isAdmin) throw new HttpError(400, "Admin accounts can't be deleted here. Please contact support.");
  if (!(await user.verifyPassword(body.password ?? ""))) {
    throw new HttpError(401, "That password doesn't match. Nothing was deleted.");
  }

  await deleteAccountData(userId);

  console.log(`[auth] account deleted (${String(userId)})`);
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Forgot password
// ---------------------------------------------------------------------------

const RESET_MINUTES = 60;
const RESETS_PER_EMAIL_PER_DAY = 3;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Same answer whether or not an account uses the address, so nobody can use this to find out who has an account. */
const FORGOT_REPLY = "If an account uses that email, we've sent a link to reset the password. Check your inbox and spam folder.";

// Per network address. A whole classroom can share one school address, so this is generous;
// the daily cap per email address below is what stops anyone flooding an inbox.
const tryLimiter = () =>
  rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, "Too many tries. Please wait a few minutes and try again.")),
  });
const forgotLimiter = tryLimiter();
const resetLimiter = tryLimiter();

const forgotSchema = z.object({ email: z.string().trim().toLowerCase().email("That email doesn't look right.").max(160) });

authRouter.post("/forgot-password", forgotLimiter, async (req, res) => {
  const { email } = forgotSchema.parse(req.body);
  const user = await User.findOne({ email, isGuest: false });
  // The reply is the same whatever happens, so this can't be used to find out who has an account.
  if (user) await sendPasswordReset(user);

  res.json({ message: FORGOT_REPLY });
});

const resetSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "This reset link isn't valid. Ask for a new one."),
  password: z.string().min(8, "Use at least 8 characters."),
});

const LINK_EXPIRED = "This reset link has expired or was already used. Ask for a new one.";

authRouter.post("/reset-password", resetLimiter, async (req, res) => {
  const { token, password } = resetSchema.parse(req.body);

  // Claim the link in one step, so it can't be used twice at the same moment.
  const reset = await PasswordReset.findOneAndUpdate(
    { tokenHash: sha256(token), usedAt: null, expiresAt: { $gt: new Date() } },
    { usedAt: new Date() },
  );
  if (!reset) throw new HttpError(400, LINK_EXPIRED);

  const user = await User.findById(reset.userId);
  if (!user) throw new HttpError(400, LINK_EXPIRED);

  user.passwordHash = await hashPassword(password);
  // Every existing session stops working; the new one below carries the new version.
  user.passwordChangedAt = new Date();
  user.sessionVersion = (user.sessionVersion ?? 0) + 1;
  await user.save();
  await PasswordReset.deleteMany({ userId: user._id });
  console.log(`[auth] password reset (account ${user.id})`);

  res.json({ token: signToken({ sub: user.id, role: user.role, v: user.sessionVersion ?? 0 }), user: publicUser(user) });
});

// ---------------------------------------------------------------------------
// Confirm email
// ---------------------------------------------------------------------------

const verifySchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "This confirmation link isn't valid. Send a new one from the app."),
});

/** Opened from the email, possibly on another device, so it doesn't need a signed-in session. */
authRouter.post("/verify-email", resetLimiter, async (req, res) => {
  const { token } = verifySchema.parse(req.body);
  const link = await claimVerificationLink(token);
  const user = link ? await User.findById(link.userId) : null;
  // The link only confirms the address it was sent to.
  if (!link || !user || user.email !== link.email) {
    throw new HttpError(400, "This confirmation link has expired or was already used. Send a new one from the app.");
  }
  if (!user.emailVerified) {
    user.emailVerified = true;
    await user.save();
  }
  res.json({ ok: true, email: user.email });
});

authRouter.post("/resend-verification", requireAuth, async (req, res) => {
  const result = await sendVerificationEmail(req.user!);
  if (result === "limit") {
    throw new HttpError(429, "We've sent 3 confirmation emails today. Check your inbox and spam folder, or try again tomorrow.");
  }
  if (result === "failed") throw new HttpError(502, "Couldn't send the email right now. Please try again in a few minutes.");
  res.json({ result, user: publicUser(req.user!) });
});
