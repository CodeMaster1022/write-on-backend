import { Router } from "express";
import { z } from "zod";
import { PARTS_OF_SPEECH, WordBankEntry } from "../models/WordBankEntry.js";

export const wordbankRouter = Router();

const querySchema = z.object({
  partOfSpeech: z.enum(PARTS_OF_SPEECH).optional(),
  tier: z.coerce.number().int().min(1).max(3).optional(),
  q: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(12),
});

/**
 * Open endpoint: the word lists are teaching content, and a guest writer
 * mid-sentence should never hit an auth wall to look up an adjective.
 */
wordbankRouter.get("/", async (req, res) => {
  const { partOfSpeech, tier, q, limit } = querySchema.parse(req.query);

  const filter: Record<string, unknown> = {};
  if (partOfSpeech) filter.partOfSpeech = partOfSpeech;
  if (tier) filter.tier = tier;
  if (q) filter.word = { $regex: `^${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, $options: "i" };

  const words = await WordBankEntry.find(filter).sort({ tier: 1, word: 1 }).limit(limit).lean();

  res.json({ words });
});

/** Grouped payload the Sentence Builder loads once on mount. */
wordbankRouter.get("/grouped", async (_req, res) => {
  const words = await WordBankEntry.find().sort({ tier: 1, word: 1 }).lean();

  const grouped = Object.fromEntries(
    PARTS_OF_SPEECH.map((pos) => [pos, words.filter((w) => w.partOfSpeech === pos)]),
  );

  res.json({ grouped });
});
