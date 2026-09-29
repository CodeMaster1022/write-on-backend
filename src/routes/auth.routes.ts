import { Router } from "express";
import { z } from "zod";
import { GRADES } from "../config/grades.js";
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
    isGuest: false,
  });

  res.status(201).json({
    token: signToken({ sub: user.id, role: user.role }),
    user: publicUser(user),
  });
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("That email doesn't look right."),
  password: z.string().min(1, "Enter your password."),
});

authRouter.post("/login", async (req, res) => {
  const body = loginSchema.parse(req.body);

  // Logs carry the account ID only, never the email address.
  const user = await User.findOne({ email: body.email }).select("+passwordHash");
  if (!user || !(await user.verifyPassword(body.password))) {
    console.log(`[auth] login failed (${user ? `account ${user.id}` : "no matching account"})`);
    throw new HttpError(401, "We couldn't match that email and password.");
  }

  console.log(`[auth] login succeeded (account ${user.id})`);

  res.json({
    token: signToken({ sub: user.id, role: user.role }),
    user: publicUser(user),
  });
});

const guestSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
});

/** Lets a student start writing immediately — matches the MVP's "Continue as Guest". */
authRouter.post("/guest", async (req, res) => {
  const body = guestSchema.parse(req.body ?? {});

  const user = await User.create({
    displayName: body.displayName?.trim() || "Guest Writer",
    role: "student",
    isGuest: true,
  });

  res.status(201).json({
    token: signToken({ sub: user.id, role: user.role }),
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
});

authRouter.patch("/me", requireAuth, async (req, res) => {
  const body = updateMeSchema.parse(req.body);
  const user = req.user!;

  if (body.displayName !== undefined) user.displayName = body.displayName;
  if (body.gradeLevel !== undefined) user.gradeLevel = body.gradeLevel ?? undefined;
  if (body.classCode !== undefined) user.classCode = body.classCode ?? undefined;

  await user.save();
  res.json({ user: publicUser(user) });
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
      grade: user.gradeLevel ?? null,
      accountType: user.isGuest ? "guest" : user.role,
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

const deleteMeSchema = z.object({ password: z.string().optional() });

/** Deletes the account and everything saved for it. This can't be undone. */
authRouter.delete("/me", requireAuth, async (req, res) => {
  const body = deleteMeSchema.parse(req.body ?? {});
  const userId = req.user!._id;

  const user = await User.findById(userId).select("+passwordHash");
  if (!user) throw new HttpError(404, "We couldn't find that account.");
  if (user.isAdmin) throw new HttpError(400, "Admin accounts can't be deleted here. Please contact support.");
  if (!user.isGuest && !(await user.verifyPassword(body.password ?? ""))) {
    throw new HttpError(401, "That password doesn't match. Nothing was deleted.");
  }

  await Promise.all([
    Writing.deleteMany({ userId }),
    Revision.deleteMany({ userId }),
    FeedbackRun.deleteMany({ userId }),
    InkiQuestion.deleteMany({ userId }),
    HelpEvent.deleteMany({ userId }),
    ContestEntry.deleteMany({ userId }),
    ReportShare.deleteMany({ userId }),
    ReportSummary.deleteMany({ userId }),
    ReportEmail.deleteMany({ userId }),
  ]);
  await user.deleteOne();

  console.log(`[auth] account deleted (${String(userId)})`);
  res.status(204).send();
});

const upgradeSchema = registerSchema.pick({ email: true, password: true, displayName: true }).partial({
  displayName: true,
});

/** Turns a guest into a real account, keeping their writing and ink drops. */
authRouter.post("/claim-guest", requireAuth, async (req, res) => {
  const body = upgradeSchema.parse(req.body);
  const user = req.user!;

  if (!user.isGuest) throw new HttpError(400, "This account is already saved.");

  const taken = await User.findOne({ email: body.email });
  if (taken) throw new HttpError(409, "An account already uses that email.");

  user.email = body.email;
  user.passwordHash = await hashPassword(body.password);
  user.isGuest = false;
  if (body.displayName) user.displayName = body.displayName;

  await user.save();

  res.json({
    token: signToken({ sub: user.id, role: user.role }),
    user: publicUser(user),
  });
});
