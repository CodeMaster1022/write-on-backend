import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { Contest, ContestEntry, contestStatus } from "../models/Contest.js";
import { FeedbackRun } from "../models/FeedbackRun.js";
import { MAX_REVISIONS, Revision } from "../models/Revision.js";
import { REWARD_PER_TYPE, WRITING_TYPES, Writing, countWords } from "../models/Writing.js";
import { publicUser } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { sendEmail } from "../lib/email.js";
import { writingCopyEmail } from "../lib/emails.js";
import { requireSchoolSafe } from "../lib/moderation.js";
import { startOfToday, timeZoneOf } from "../lib/time.js";
import { requireVerifiedEmail } from "../lib/verification.js";
import { EmailLog } from "../models/PasswordReset.js";
import { HttpError } from "../middleware/error.js";

export const writingsRouter = Router();

writingsRouter.use(requireAuth);

const NOT_FOUND = "We couldn't find that piece of writing.";
const objectId = z.string().regex(/^[a-f0-9]{24}$/);

function writingId(raw: unknown): string {
  const parsed = objectId.safeParse(raw);
  if (!parsed.success) throw new HttpError(404, NOT_FOUND);
  return parsed.data;
}

async function findOwn(req: { params: { id?: string | string[] }; user?: { _id: unknown } }) {
  const writing = await Writing.findOne({ _id: writingId(req.params.id), userId: req.user!._id });
  if (!writing) throw new HttpError(404, NOT_FOUND);
  return writing;
}

/** Links an AI check to a saved piece, only if it's the student's own and not already used. */
async function claimFeedbackRun(runId: string | undefined, userId: unknown, writing: unknown): Promise<string | null> {
  if (!runId) return null;
  const result = await FeedbackRun.updateOne({ _id: runId, userId, writingId: null }, { writingId: writing });
  return result.matchedCount > 0 ? runId : null;
}

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

  const counts = await Revision.aggregate<{ _id: unknown; n: number }>([
    { $match: { writingId: { $in: writings.map((w) => w._id) } } },
    { $group: { _id: "$writingId", n: { $sum: 1 } } },
  ]);
  const countById = new Map(counts.map((c) => [String(c._id), c.n]));

  res.json({ writings: writings.map((w) => ({ ...w, versionCount: countById.get(String(w._id)) ?? 1 })) });
});

const createSchema = z.object({
  type: z.enum(WRITING_TYPES),
  title: z.string().trim().max(140).optional(),
  content: z.string().trim().min(1, "Write something first!").max(20_000),
  parts: z.record(z.string(), z.unknown()).optional(),
});

const MAX_ACTIVE_SECONDS = 6 * 60 * 60;

const saveExtrasSchema = z.object({
  activeSeconds: z.number().int().min(0).max(MAX_ACTIVE_SECONDS).optional(),
  feedbackRunId: objectId.optional(),
});

/**
 * Pieces that earn ink drops per day. Saving never stops, but after this many
 * the drops do, so nobody can fill the closet by saving one-word sentences all afternoon.
 */
export const REWARDED_PIECES_PER_DAY = 10;

writingsRouter.post("/", async (req, res) => {
  const body = createSchema.extend(saveExtrasSchema.shape).parse(req.body);
  const user = req.user!;
  await requireSchoolSafe([body.title, body.content]);

  const rewardedToday = await Writing.countDocuments({
    userId: user._id,
    inkDropsEarned: { $gt: 0 },
    createdAt: { $gte: startOfToday(timeZoneOf(req)) },
  });
  const rewardCapReached = rewardedToday >= REWARDED_PIECES_PER_DAY;
  const earned = rewardCapReached ? 0 : REWARD_PER_TYPE[body.type];

  const writing = await Writing.create({
    userId: user._id,
    type: body.type,
    title: body.title ?? "",
    content: body.content,
    parts: body.parts ?? {},
    wordCount: countWords(body.content),
    inkDropsEarned: earned,
    activeSeconds: body.activeSeconds ?? 0,
  });

  const runId = await claimFeedbackRun(body.feedbackRunId, user._id, writing._id);
  await Revision.create({
    writingId: writing._id,
    userId: user._id,
    content: writing.content,
    wordCount: writing.wordCount,
    feedbackRunId: runId,
  });

  user.inkDrops += earned;
  user.writingCount += 1;
  user.lastWroteAt = new Date();
  await user.save();

  res.status(201).json({
    writing,
    inkDropsEarned: earned,
    rewardCapReached,
    user: publicUser(user),
  });
});

type ContestLink = { id: string; title: string; closed: boolean };

/**
 * The contest this piece was entered in, if any. A closed contest wins over
 * an open one, since a closed entry must stay exactly as the judge received it.
 */
async function contestFor(id: unknown): Promise<ContestLink | null> {
  const entries = await ContestEntry.find({ writingId: id }).select("contestId").lean();
  if (entries.length === 0) return null;

  const contests = await Contest.find({ _id: { $in: entries.map((e) => e.contestId) } })
    .select("title startsAt endsAt announcedAt")
    .lean();
  const links = contests.map((c) => ({
    id: String(c._id),
    title: c.title,
    closed: ["judging", "announced"].includes(contestStatus(c)),
  }));
  return links.find((l) => l.closed) ?? links[0] ?? null;
}

writingsRouter.get("/:id", async (req, res) => {
  const writing = await findOwn(req);
  res.json({ writing: writing.toObject(), contest: await contestFor(writing._id) });
});

/** Every saved version, oldest first, with the AI ratings made on that version. */
writingsRouter.get("/:id/revisions", async (req, res) => {
  const writing = await findOwn(req);
  const revisions = await Revision.find({ writingId: writing._id }).sort({ createdAt: 1 }).lean();

  // Pieces saved before versions were kept have no history yet: show the piece itself as version 1.
  const versions = revisions.length
    ? revisions.map((r) => ({ content: r.content, wordCount: r.wordCount, savedAt: r.createdAt, runId: r.feedbackRunId }))
    : [
        {
          content: writing.content,
          wordCount: writing.wordCount,
          savedAt: writing.createdAt,
          runId: (await FeedbackRun.findOne({ writingId: writing._id }).sort({ createdAt: -1 }).select("_id").lean())?._id ?? null,
        },
      ];

  const runIds = versions.map((v) => v.runId).filter((id) => id !== null);
  const runs = await FeedbackRun.find({ _id: { $in: runIds } }).select("ratings").lean();
  const ratingsById = new Map(runs.map((r) => [String(r._id), r.ratings]));

  res.json({
    revisions: versions.map((v, i) => ({
      number: i + 1,
      content: v.content,
      wordCount: v.wordCount,
      savedAt: v.savedAt,
      ratings: v.runId ? (ratingsById.get(String(v.runId)) ?? null) : null,
    })),
  });
});

const updateSchema = createSchema.partial().omit({ type: true }).extend(saveExtrasSchema.shape);

writingsRouter.patch("/:id", async (req, res) => {
  const body = updateSchema.parse(req.body);
  const userId = req.user!._id;
  const writing = await findOwn(req);

  const contest = await contestFor(writing._id);
  if (contest?.closed) {
    throw new HttpError(400, `This piece is your entry in ${contest.title}, which has closed, so it can't be changed.`);
  }

  const contentChanged = body.content !== undefined && body.content !== writing.content;
  await requireSchoolSafe([body.title !== writing.title ? body.title : null, contentChanged ? body.content : null]);
  if (contentChanged) {
    const saved = await Revision.countDocuments({ writingId: writing._id });
    if (saved >= MAX_REVISIONS) {
      throw new HttpError(400, `This piece already has ${MAX_REVISIONS} versions. Start a new piece to keep going!`);
    }
    // Keep the text it had before this first edit, for pieces saved before versions existed.
    if (saved === 0) {
      await Revision.create({
        writingId: writing._id,
        userId,
        content: writing.content,
        wordCount: writing.wordCount,
        createdAt: writing.createdAt,
      });
    }
  }

  if (body.title !== undefined) writing.title = body.title;
  if (body.parts !== undefined) writing.parts = body.parts;
  if (contentChanged) {
    writing.content = body.content!;
    writing.wordCount = countWords(body.content!);
  }
  if (body.activeSeconds) {
    writing.activeSeconds = Math.min(MAX_ACTIVE_SECONDS * 4, (writing.activeSeconds ?? 0) + body.activeSeconds);
  }
  await writing.save();

  const runId = await claimFeedbackRun(body.feedbackRunId, userId, writing._id);
  if (contentChanged) {
    await Revision.create({
      writingId: writing._id,
      userId,
      content: writing.content,
      wordCount: writing.wordCount,
      feedbackRunId: runId,
    });
  } else if (runId) {
    // A check on the unchanged text belongs to the latest version.
    await Revision.findOneAndUpdate({ writingId: writing._id }, { feedbackRunId: runId }, { sort: { createdAt: -1 } });
  }

  res.json({ writing, versionCount: await Revision.countDocuments({ writingId: writing._id }) });
});

const COPIES_PER_DAY = 5;
const emailCopySchema = z.object({ to: z.string().trim().toLowerCase().email("That email doesn't look right.").max(160) });

/** "Email me a copy": sends the piece to an address the student gives. The address isn't stored. */
writingsRouter.post("/:id/email", async (req, res) => {
  const { to } = emailCopySchema.parse(req.body);
  const writing = await findOwn(req);
  const user = req.user!;
  requireVerifiedEmail(user);
  const tz = timeZoneOf(req);

  const sentToday = await EmailLog.countDocuments({ userId: user._id, kind: "writing_copy", createdAt: { $gte: startOfToday(tz) } });
  if (sentToday >= COPIES_PER_DAY) {
    throw new HttpError(429, `You can email up to ${COPIES_PER_DAY} copies a day. You can always find your writing in My writing.`);
  }

  const date = writing.createdAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: tz });
  await sendEmail({
    to,
    ...writingCopyEmail({ studentName: user.displayName, type: writing.type, title: writing.title, content: writing.content, date }),
    failMessage: "Couldn't send that email right now. Your writing is saved in My writing.",
  });
  await EmailLog.create({ userId: user._id, kind: "writing_copy", toHash: createHash("sha256").update(to).digest("hex") });

  res.status(204).send();
});

/** Removes a piece and its versions. The student keeps the ink drops it earned; the piece count goes down. */
writingsRouter.delete("/:id", async (req, res) => {
  const id = writingId(req.params.id);
  const user = req.user!;
  const result = await Writing.deleteOne({ _id: id, userId: user._id });
  if (result.deletedCount === 0) throw new HttpError(404, NOT_FOUND);
  await Revision.deleteMany({ writingId: id });
  user.writingCount = Math.max(0, user.writingCount - 1);
  await user.save();
  res.json({ user: publicUser(user) });
});
