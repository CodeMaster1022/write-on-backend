import { Router } from "express";
import { z } from "zod";
import { NOUN_CATEGORIES, PARTS_OF_SPEECH, VERB_TYPES, WordBankEntry } from "../models/WordBankEntry.js";

export const wordbankRouter = Router();

const querySchema = z.object({
  partOfSpeech: z.enum(PARTS_OF_SPEECH).optional(),
  category: z.enum(NOUN_CATEGORIES).optional(),
  verbType: z.enum(VERB_TYPES).optional(),
  tier: z.coerce.number().int().min(1).max(3).optional(),
  q: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(12),
});

/**
 * Open endpoint: the word lists are teaching content, and a guest writer
 * mid-sentence should never hit an auth wall to look up an adjective.
 */
wordbankRouter.get("/", async (req, res) => {
  const { partOfSpeech, category, verbType, tier, q, limit } = querySchema.parse(req.query);

  const filter: Record<string, unknown> = {};
  if (partOfSpeech) filter.partOfSpeech = partOfSpeech;
  if (category) filter.category = category;
  if (verbType) filter.verbType = verbType;
  if (tier) filter.tier = tier;
  if (q) filter.word = { $regex: `^${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, $options: "i" };

  const words = await WordBankEntry.find(filter).sort({ tier: 1, word: 1 }).limit(limit).lean();

  res.json({ words });
});

/** Powers Noun Assistance's people / places / things columns in one call. */
wordbankRouter.get("/noun-categories", async (_req, res) => {
  const nouns = await WordBankEntry.find({ partOfSpeech: "noun", category: { $ne: null } })
    .sort({ word: 1 })
    .lean();

  const grouped = Object.fromEntries(
    NOUN_CATEGORIES.map((cat) => [cat, nouns.filter((n) => n.category === cat)]),
  );

  res.json({ grouped });
});

/** Powers Verb Assistance's Action / Linking columns in one call. */
wordbankRouter.get("/verb-types", async (_req, res) => {
  const verbs = await WordBankEntry.find({ partOfSpeech: "verb", verbType: { $ne: null } })
    .sort({ word: 1 })
    .lean();

  const grouped = Object.fromEntries(
    VERB_TYPES.map((type) => [type, verbs.filter((v) => v.verbType === type)]),
  );

  res.json({ grouped });
});

/** Grouped payload the Sentence Builder loads once on mount. */
wordbankRouter.get("/grouped", async (_req, res) => {
  const words = await WordBankEntry.find().sort({ tier: 1, word: 1 }).lean();

  const grouped = Object.fromEntries(
    PARTS_OF_SPEECH.map((pos) => [pos, words.filter((w) => w.partOfSpeech === pos)]),
  );

  res.json({ grouped });
});
