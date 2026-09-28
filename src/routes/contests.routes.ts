import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { Contest, ContestEntry, contestStatus } from "../models/Contest.js";
import { RewardItem } from "../models/RewardItem.js";
import { publicUser } from "../models/User.js";
import { Writing } from "../models/Writing.js";

export const contestsRouter = Router();

contestsRouter.use(requireAuth);

const RECENT_DAYS = 45;
const objectId = z.string().regex(/^[a-f0-9]{24}$/);

function idParam(raw: unknown, notFound: string): string {
  const parsed = objectId.safeParse(raw);
  if (!parsed.success) throw new HttpError(404, notFound);
  return parsed.data;
}

async function prizesByKey(keys: string[]) {
  const items = await RewardItem.find({ key: { $in: keys } }).select("key name slot blurb").lean();
  return new Map(items.map((i) => [i.key, { key: i.key, name: i.name, slot: i.slot, blurb: i.blurb ?? "" }]));
}

/** Open, upcoming, and recently finished contests, with this student's entry for each. */
contestsRouter.get("/", async (req, res) => {
  const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const contests = await Contest.find({ endsAt: { $gte: since } }).sort({ startsAt: -1 }).limit(20).lean();
  const ids = contests.map((c) => c._id);

  const [mine, counts, prizes] = await Promise.all([
    ContestEntry.find({ contestId: { $in: ids }, userId: req.user!._id }).lean(),
    ContestEntry.aggregate<{ _id: unknown; entries: number; winners: number }>([
      { $match: { contestId: { $in: ids } } },
      { $group: { _id: "$contestId", entries: { $sum: 1 }, winners: { $sum: { $cond: ["$isWinner", 1, 0] } } } },
    ]),
    prizesByKey(contests.map((c) => c.prizeKey)),
  ]);

  const mineByContest = new Map(mine.map((e) => [String(e.contestId), e]));
  const countsByContest = new Map(counts.map((c) => [String(c._id), c]));

  res.json({
    contests: contests.map((c) => {
      const status = contestStatus(c);
      const entry = mineByContest.get(String(c._id));
      const count = countsByContest.get(String(c._id));
      return {
        id: String(c._id),
        title: c.title,
        prompt: c.prompt,
        writingType: c.writingType,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        status,
        prize: prizes.get(c.prizeKey) ?? null,
        stepCount: (c.steps ?? []).length,
        entryCount: count?.entries ?? 0,
        // Winners stay private until Erin announces them.
        winnerCount: status === "announced" ? (count?.winners ?? 0) : null,
        myEntry: entry
          ? {
              id: String(entry._id),
              writingId: String(entry.writingId),
              enteredAt: entry.updatedAt,
              isWinner: status === "announced" ? entry.isWinner : null,
            }
          : null,
      };
    }),
  });
});

const enterSchema = z.object({ writingId: objectId });

/** Enter (or swap) a piece of writing. Every entrant gets the contest's prize straight away. */
contestsRouter.post("/:id/enter", async (req, res) => {
  const contestId = idParam(req.params.id, "We couldn't find that contest.");
  const { writingId } = enterSchema.parse(req.body);
  const user = req.user!;

  const contest = await Contest.findById(contestId).lean();
  if (!contest) throw new HttpError(404, "We couldn't find that contest.");

  const status = contestStatus(contest);
  if (status === "upcoming") throw new HttpError(400, "This contest hasn't started yet.");
  if (status !== "open") throw new HttpError(400, "This contest has closed. Watch for the next one!");

  const writing = await Writing.findOne({ _id: writingId, userId: user._id }).select("type createdAt parts").lean();
  if (!writing) throw new HttpError(404, "We couldn't find that piece of writing.");
  if (writing.type !== contest.writingType) {
    throw new HttpError(400, `This contest is for a ${contest.writingType}. Write one to enter!`);
  }
  const parts = (writing.parts ?? {}) as Record<string, unknown>;
  if ((contest.steps ?? []).length > 0 && parts.contestId !== String(contest._id)) {
    throw new HttpError(400, "Write your entry with this contest's steps to enter.");
  }
  if (writing.createdAt < contest.startsAt) {
    throw new HttpError(400, "Contest entries need to be written after the contest starts.");
  }

  const entry = await ContestEntry.findOneAndUpdate(
    { contestId: contest._id, userId: user._id },
    { $set: { writingId: writing._id } },
    { upsert: true, new: true },
  );

  const prizeGranted = !user.ownedItems.includes(contest.prizeKey);
  if (prizeGranted) {
    user.ownedItems.push(contest.prizeKey);
    await user.save();
  }

  const prizes = await prizesByKey([contest.prizeKey]);
  res.json({
    entryId: String(entry._id),
    prize: prizes.get(contest.prizeKey) ?? null,
    prizeGranted,
    user: publicUser(user),
  });
});

/** Announced wins, for the library's winner badges and the one-time celebration screen. */
contestsRouter.get("/wins", async (req, res) => {
  const entries = await ContestEntry.find({ userId: req.user!._id, isWinner: true }).lean();
  if (entries.length === 0) {
    res.json({ wins: [] });
    return;
  }

  const contests = await Contest.find({ _id: { $in: entries.map((e) => e.contestId) }, announcedAt: { $ne: null } }).lean();
  const byId = new Map(contests.map((c) => [String(c._id), c]));
  const prizes = await prizesByKey(contests.map((c) => c.prizeKey));

  res.json({
    wins: entries.flatMap((e) => {
      const c = byId.get(String(e.contestId));
      if (!c) return [];
      return [
        {
          entryId: String(e._id),
          contestId: String(c._id),
          contestTitle: c.title,
          writingId: String(e.writingId),
          prize: prizes.get(c.prizeKey) ?? null,
          seen: e.winnerSeenAt !== null,
        },
      ];
    }),
  });
});

contestsRouter.post("/wins/:entryId/seen", async (req, res) => {
  const entryId = idParam(req.params.entryId, "We couldn't find that win.");
  await ContestEntry.updateOne(
    { _id: entryId, userId: req.user!._id, isWinner: true, winnerSeenAt: null },
    { winnerSeenAt: new Date() },
  );
  res.status(204).send();
});

/** One contest with Erin's step-by-step questions, for the contest writing page. Registered last so "/wins" isn't read as an id. */
contestsRouter.get("/:id", async (req, res) => {
  const contestId = idParam(req.params.id, "We couldn't find that contest.");
  const contest = await Contest.findById(contestId).lean();
  if (!contest) throw new HttpError(404, "We couldn't find that contest.");

  const [entry, prizes] = await Promise.all([
    ContestEntry.findOne({ contestId: contest._id, userId: req.user!._id }).lean(),
    prizesByKey([contest.prizeKey]),
  ]);

  res.json({
    contest: {
      id: String(contest._id),
      title: contest.title,
      prompt: contest.prompt,
      writingType: contest.writingType,
      startsAt: contest.startsAt,
      endsAt: contest.endsAt,
      status: contestStatus(contest),
      prize: prizes.get(contest.prizeKey) ?? null,
      steps: (contest.steps ?? []).map((s) => ({ question: s.question, example: s.example ?? "" })),
      entered: entry !== null,
    },
  });
});
