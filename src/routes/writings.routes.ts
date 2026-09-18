import { Router } from "express";
import { z } from "zod";
import { REWARD_PER_TYPE, WRITING_TYPES, Writing, countWords } from "../models/Writing.js";
import { publicUser } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";

export const writingsRouter = Router();

writingsRouter.use(requireAuth);

const listQuerySchema = z.object({
  type: z.enum(WRITING_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

writingsRouter.get("/", async (req, res) => {
  const { type, limit } = listQuerySchema.parse(req.query);

  const writings = await Writing.find({
    userId: req.user!._id,
    ...(type ? { type } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  res.json({ writings });
});

const createSchema = z.object({
  type: z.enum(WRITING_TYPES),
  title: z.string().trim().max(140).optional(),
  content: z.string().trim().min(1, "Write something first!").max(20_000),
  parts: z.record(z.string(), z.unknown()).optional(),
});

writingsRouter.post("/", async (req, res) => {
  const body = createSchema.parse(req.body);
  const user = req.user!;

  const earned = REWARD_PER_TYPE[body.type];

  const writing = await Writing.create({
    userId: user._id,
    type: body.type,
    title: body.title ?? "",
    content: body.content,
    parts: body.parts ?? {},
    wordCount: countWords(body.content),
    inkDropsEarned: earned,
  });

  user.inkDrops += earned;
  user.writingCount += 1;
  user.lastWroteAt = new Date();
  await user.save();

  res.status(201).json({
    writing,
    inkDropsEarned: earned,
    user: publicUser(user),
  });
});

writingsRouter.get("/:id", async (req, res) => {
  const writing = await Writing.findOne({ _id: req.params.id, userId: req.user!._id }).lean();
  if (!writing) throw new HttpError(404, "We couldn't find that piece of writing.");
  res.json({ writing });
});

const updateSchema = createSchema.partial().omit({ type: true });

writingsRouter.patch("/:id", async (req, res) => {
  const body = updateSchema.parse(req.body);

  const writing = await Writing.findOne({ _id: req.params.id, userId: req.user!._id });
  if (!writing) throw new HttpError(404, "We couldn't find that piece of writing.");

  if (body.title !== undefined) writing.title = body.title;
  if (body.parts !== undefined) writing.parts = body.parts;
  if (body.content !== undefined) {
    writing.content = body.content;
    writing.wordCount = countWords(body.content);
  }

  await writing.save();
  res.json({ writing });
});

writingsRouter.delete("/:id", async (req, res) => {
  const result = await Writing.deleteOne({ _id: req.params.id, userId: req.user!._id });
  if (result.deletedCount === 0) throw new HttpError(404, "We couldn't find that piece of writing.");
  res.status(204).send();
});
