import { Router } from "express";
import { z } from "zod";
import { User, hashPassword, publicUser } from "../models/User.js";
import { requireAuth, signToken } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";

export const authRouter = Router();

const registerSchema = z.object({
  displayName: z.string().trim().min(1, "Tell us your name.").max(60),
  email: z.string().trim().toLowerCase().email("That email doesn't look right."),
  password: z.string().min(8, "Use at least 8 characters."),
  role: z.enum(["student", "teacher"]).default("student"),
  gradeLevel: z.string().trim().max(20).optional(),
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
    role: body.role,
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

  const user = await User.findOne({ email: body.email }).select("+passwordHash");
  if (!user || !(await user.verifyPassword(body.password))) {
    console.log(`[auth] login failed for ${body.email}`);
    throw new HttpError(401, "We couldn't match that email and password.");
  }

  console.log(`[auth] login succeeded for ${user.email} (${user.id})`);

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
  gradeLevel: z.string().trim().max(20).nullable().optional(),
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
