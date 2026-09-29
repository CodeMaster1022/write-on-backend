import { Router } from "express";
import { z } from "zod";
import { GRADES, wordTiersFor } from "../config/grades.js";
import { NOUN_CATEGORIES, PARTS_OF_SPEECH, VERB_TYPES, WordBankEntry } from "../models/WordBankEntry.js";

export const wordbankRouter = Router();

/** The student's grade, sent by the client, so word ideas fit their level. Optional: guests may have none. */
const gradeSchema = z.object({ grade: z.enum(GRADES).optional().catch(undefined) });

const querySchema = gradeSchema.extend({
  partOfSpeech: z.enum(PARTS_OF_SPEECH).optional(),
  category: z.enum(NOUN_CATEGORIES).optional(),
  verbType: z.enum(VERB_TYPES).optional(),
  tier: z.coerce.number().int().min(1).max(3).optional(),
  q: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(12),
});

/** Keeps only the tiers a grade should see, in the order it should see them, then alphabetical. */
function forGrade<T extends { tier: number; word: string }>(words: T[], grade: string | undefined): T[] {
  const tiers = wordTiersFor(grade);
  return words
    .filter((w) => tiers.includes(w.tier))
    .sort((a, b) => tiers.indexOf(a.tier) - tiers.indexOf(b.tier) || a.word.localeCompare(b.word));
}

/**
 * Open endpoint: the word lists are teaching content, and a guest writer
 * mid-sentence should never hit an auth wall to look up an adjective.
 */
wordbankRouter.get("/", async (req, res) => {
  const { partOfSpeech, category, verbType, tier, q, limit, grade } = querySchema.parse(req.query);

  const filter: Record<string, unknown> = {};
  if (partOfSpeech) filter.partOfSpeech = partOfSpeech;
  if (category) filter.category = category;
  if (verbType) filter.verbType = verbType;
  if (tier) filter.tier = tier;
  if (q) filter.word = { $regex: `^${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, $options: "i" };

  // The word bank is small, so sorting by grade in memory is simpler than in the query.
  const words = await WordBankEntry.find(filter).limit(500).lean();

  res.json({ words: forGrade(words, grade).slice(0, limit) });
});

/** Powers Noun Assistance's people / places / things columns in one call. */
wordbankRouter.get("/noun-categories", async (req, res) => {
  const { grade } = gradeSchema.parse(req.query);
  const nouns = forGrade(await WordBankEntry.find({ partOfSpeech: "noun", category: { $ne: null } }).lean(), grade);

  const grouped = Object.fromEntries(
    NOUN_CATEGORIES.map((cat) => [cat, nouns.filter((n) => n.category === cat)]),
  );

  res.json({ grouped });
});

/** Powers Verb Assistance's Action / Linking columns in one call. */
wordbankRouter.get("/verb-types", async (req, res) => {
  const { grade } = gradeSchema.parse(req.query);
  const verbs = forGrade(await WordBankEntry.find({ partOfSpeech: "verb", verbType: { $ne: null } }).lean(), grade);

  const grouped = Object.fromEntries(
    VERB_TYPES.map((type) => [type, verbs.filter((v) => v.verbType === type)]),
  );

  res.json({ grouped });
});

/** Grouped payload the Sentence Builder loads once on mount. */
wordbankRouter.get("/grouped", async (req, res) => {
  const { grade } = gradeSchema.parse(req.query);
  const words = forGrade(await WordBankEntry.find().lean(), grade);

  const grouped = Object.fromEntries(
    PARTS_OF_SPEECH.map((pos) => [pos, words.filter((w) => w.partOfSpeech === pos)]),
  );

  res.json({ grouped });
});
