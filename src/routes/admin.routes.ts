import { Router } from "express";
import { z } from "zod";
import { normalizeGrade } from "../config/grades.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { Contest, ContestEntry, contestStatus } from "../models/Contest.js";
import { RewardItem } from "../models/RewardItem.js";
import { User } from "../models/User.js";
import { WRITING_TYPES, Writing } from "../models/Writing.js";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

const ENTRIES_PER_PAGE = 25;
const objectId = z.string().regex(/^[a-f0-9]{24}$/);

function idParam(raw: unknown, notFound: string): string {
  const parsed = objectId.safeParse(raw);
  if (!parsed.success) throw new HttpError(404, notFound);
  return parsed.data;
}

async function requireContest(raw: unknown) {
  const contest = await Contest.findById(idParam(raw, "We couldn't find that contest."));
  if (!contest) throw new HttpError(404, "We couldn't find that contest.");
  return contest;
}

async function requirePrize(key: string) {
  const item = await RewardItem.findOne({ key, exclusive: true }).lean();
  if (!item) throw new HttpError(400, "Pick one of the contest prizes.");
}

/** Exclusive closet items that can be used as contest prizes. */
adminRouter.get("/prizes", async (_req, res) => {
  const items = await RewardItem.find({ exclusive: true }).sort({ slot: 1, sortOrder: 1 }).lean();
  res.json({ prizes: items.map((i) => ({ key: i.key, name: i.name, slot: i.slot, blurb: i.blurb ?? "" })) });
});

adminRouter.get("/contests", async (_req, res) => {
  const contests = await Contest.find().sort({ startsAt: -1 }).limit(100).lean();
  const counts = await ContestEntry.aggregate<{ _id: unknown; entries: number; winners: number }>([
    { $match: { contestId: { $in: contests.map((c) => c._id) } } },
    { $group: { _id: "$contestId", entries: { $sum: 1 }, winners: { $sum: { $cond: ["$isWinner", 1, 0] } } } },
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c]));

  res.json({
    contests: contests.map((c) => ({
      id: String(c._id),
      title: c.title,
      prompt: c.prompt,
      writingType: c.writingType,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      prizeKey: c.prizeKey,
      announcedAt: c.announcedAt,
      status: contestStatus(c),
      entryCount: byId.get(String(c._id))?.entries ?? 0,
      winnerCount: byId.get(String(c._id))?.winners ?? 0,
    })),
  });
});

const contestFields = z.object({
  title: z.string().trim().min(1, "Give the contest a title.").max(80),
  prompt: z.string().trim().min(1, "Say what students should write about.").max(400),
  writingType: z.enum(WRITING_TYPES),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  prizeKey: z.string().trim().min(1, "Pick a prize."),
});

const createSchema = contestFields.refine((c) => c.endsAt > c.startsAt, {
  message: "The end date needs to be after the start date.",
  path: ["endsAt"],
});

adminRouter.post("/contests", async (req, res) => {
  const body = createSchema.parse(req.body);
  await requirePrize(body.prizeKey);
  const contest = await Contest.create({ ...body, createdBy: req.user!._id });
  res.status(201).json({ id: contest.id as string });
});

adminRouter.patch("/contests/:id", async (req, res) => {
  const contest = await requireContest(req.params.id);
  const body = contestFields.partial().parse(req.body);

  const hasEntries = (await ContestEntry.countDocuments({ contestId: contest._id })) > 0;
  if (hasEntries && (body.writingType !== undefined || body.prizeKey !== undefined)) {
    throw new HttpError(400, "Students have already entered, so the writing type and prize can't change.");
  }
  if (body.prizeKey !== undefined) await requirePrize(body.prizeKey);

  contest.set(body);
  if (contest.endsAt <= contest.startsAt) throw new HttpError(400, "The end date needs to be after the start date.");
  await contest.save();
  res.json({ ok: true });
});

const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1) });

/** Entries in the order they came in, with the writing itself so Erin can judge. */
adminRouter.get("/contests/:id/entries", async (req, res) => {
  const contest = await requireContest(req.params.id);
  const { page } = pageSchema.parse(req.query);

  const [total, entries] = await Promise.all([
    ContestEntry.countDocuments({ contestId: contest._id }),
    ContestEntry.find({ contestId: contest._id })
      .sort({ createdAt: 1 })
      .skip((page - 1) * ENTRIES_PER_PAGE)
      .limit(ENTRIES_PER_PAGE)
      .lean(),
  ]);

  const [users, writings] = await Promise.all([
    User.find({ _id: { $in: entries.map((e) => e.userId) } }).select("displayName gradeLevel").lean(),
    Writing.find({ _id: { $in: entries.map((e) => e.writingId) } }).select("title content wordCount createdAt").lean(),
  ]);
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const writingById = new Map(writings.map((w) => [String(w._id), w]));

  res.json({
    total,
    page,
    pageSize: ENTRIES_PER_PAGE,
    entries: entries.map((e) => {
      const u = userById.get(String(e.userId));
      const w = writingById.get(String(e.writingId));
      return {
        id: String(e._id),
        student: u?.displayName ?? "Unknown writer",
        grade: normalizeGrade(u?.gradeLevel),
        enteredAt: e.updatedAt,
        isWinner: e.isWinner,
        writing: w ? { title: w.title, content: w.content, wordCount: w.wordCount } : null,
      };
    }),
  });
});

const winnerSchema = z.object({ isWinner: z.boolean() });

adminRouter.post("/contests/:id/entries/:entryId/winner", async (req, res) => {
  const contest = await requireContest(req.params.id);
  const entryId = idParam(req.params.entryId, "We couldn't find that entry.");
  const { isWinner } = winnerSchema.parse(req.body);

  const result = await ContestEntry.updateOne(
    { _id: entryId, contestId: contest._id },
    isWinner ? { isWinner: true } : { isWinner: false, winnerSeenAt: null },
  );
  if (result.matchedCount === 0) throw new HttpError(404, "We couldn't find that entry.");
  res.json({ ok: true });
});

/** Makes the winners visible to students. Only after the contest has closed. */
adminRouter.post("/contests/:id/announce", async (req, res) => {
  const contest = await requireContest(req.params.id);
  const status = contestStatus(contest);
  if (status === "announced") throw new HttpError(400, "Winners were already announced.");
  if (status !== "judging") throw new HttpError(400, "Winners can be announced once the contest has closed.");

  const winners = await ContestEntry.countDocuments({ contestId: contest._id, isWinner: true });
  if (winners === 0) throw new HttpError(400, "Pick at least one winner first.");

  contest.announcedAt = new Date();
  await contest.save();
  res.json({ ok: true, winners });
});
