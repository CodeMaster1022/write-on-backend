import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { gradeBand, type GradeBand } from "../config/grades.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { analyzeLimiter } from "../middleware/rate-limit.js";
import { chatJson } from "../lib/openai.js";
import { startOfToday, timeZoneOf } from "../lib/time.js";
import { FeedbackRun, ISSUE_CATEGORIES } from "../models/FeedbackRun.js";
import { WRITING_TYPES, type WritingType } from "../models/Writing.js";

export const aiRouter = Router();

aiRouter.use(requireAuth);

/** Generous enough for regenerate-and-recheck loops across a few pieces, but a hard cap on OpenAI spend per student. */
const ANALYZE_PER_DAY = 40;

const bodySchema = z.object({
  type: z.enum(WRITING_TYPES),
  content: z.string().trim().min(1, "There's nothing to look at yet.").max(20_000),
});

const SYSTEM_PROMPT = `You are Inki, a warm, encouraging writing coach for K-12 students, including neurodivergent students and English language learners. A student has finished a draft and wants feedback before submitting it.

Give feedback in three areas:
- grammar: capitalization, punctuation, spelling, verb tense, subject-verb agreement, run-on sentences, sentence fragments, word choice.
- evidence: is the main idea or opinion backed up with reasons, examples, or details? Point to the claim that most needs support.
- flow: transition words, logical order, whether sentences connect, repeated words, and variety in how sentences begin.

Rules:
- Plain, simple words a young student can understand. No jargon, no letter or number grades.
- "praise" is one short sentence about something genuinely good in that area.
- Give 0 to 3 issues per area, most important first. Only list real problems; an empty list is fine for strong writing.
- Each issue's "quote" must be copied exactly, character for character, from the student's draft (a short phrase, not a whole paragraph). Use "" if the issue is about something missing rather than a specific phrase.
- Each "suggestion" is one concrete, actionable sentence ("Try adding a comma after 'First'"), never vague ("be more descriptive").
- Never rewrite the whole piece and never write new sentences for the student. Coach, don't do the work.
- "rating" per area: 3 = strong, 2 = on the right track, 1 = needs some work.
- "summary" is 1-2 friendly sentences talking directly to the student about the whole piece.
- Never mention being an AI, and never discuss anything other than this piece of writing.`;

const SENTENCE_NOTE =
  "This is a single sentence, so give grammar feedback only. Set evidence and flow to null.";

/** What to expect from each grade band. Students with no grade get the base instructions only. */
const BAND_NOTE: Record<GradeBand, string> = {
  youngest: `This is a young writer (kindergarten to 2nd grade).
- Keep "summary", "praise" and every "suggestion" very short, with small everyday words a 6-year-old knows.
- Give at most 1 issue per area: the single most important one.
- Focus grammar on the basics: a capital letter at the start, a period or other end mark, spelling of common words, and complete sentences.
- For evidence and flow, one reason or detail, and simple joining words like "and", "then" or "because", are strong work at this age. Rate generously.`,
  middle: `This student is in 3rd to 5th grade.
- Expect complete sentences, correct capitals and end marks, a clear main idea backed by at least one reason or example, and simple transition words like "first", "next", "also" and "finally".`,
  oldest: `This student is in 6th grade or older.
- Expect specific, relevant evidence for each claim, not just opinions; varied sentence beginnings and lengths; precise word choice; a formal school tone with no casual language; and transitions that show how ideas relate, like "however", "as a result" and "for example".
- Rate against these expectations: a 3 means strong work for this grade.
- You may use terms like "claim", "evidence", "transition" and "tone".`,
};

const YOUNGEST_MAX_ISSUES = 1;

const RATING = z.number().int().min(1).max(3);

const areaSchema = z.object({
  rating: RATING,
  praise: z.string().max(400),
  issues: z
    .array(
      z.object({
        quote: z.string().max(400),
        suggestion: z.string().min(1).max(400),
        category: z.enum(ISSUE_CATEGORIES),
      }),
    )
    .max(3),
});

const feedbackSchema = z.object({
  summary: z.string().min(1).max(600),
  grammar: areaSchema,
  evidence: areaSchema.nullable(),
  flow: areaSchema.nullable(),
});

type Feedback = z.infer<typeof feedbackSchema>;

// OpenAI structured-output schema; strict mode needs every key listed as required.
const AREA_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rating", "praise", "issues"],
  properties: {
    rating: { type: "integer", enum: [1, 2, 3] },
    praise: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["quote", "suggestion", "category"],
        properties: {
          quote: { type: "string" },
          suggestion: { type: "string" },
          category: { type: "string", enum: [...ISSUE_CATEGORIES] },
        },
      },
    },
  },
};

const FEEDBACK_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "grammar", "evidence", "flow"],
  properties: {
    summary: { type: "string" },
    grammar: AREA_JSON_SCHEMA,
    evidence: { anyOf: [AREA_JSON_SCHEMA, { type: "null" }] },
    flow: { anyOf: [AREA_JSON_SCHEMA, { type: "null" }] },
  },
};

const FAIL_MESSAGE = "Couldn't get AI feedback right now. Please try again in a moment.";

/**
 * Drops quotes the model didn't copy exactly (so the client never highlights
 * text that isn't there), and forces sentence feedback to grammar only.
 */
function tidy(feedback: Feedback, content: string, type: WritingType, maxIssues = 3): Feedback {
  const cleanArea = <T extends Feedback["grammar"] | null>(area: T): T => {
    if (!area) return area;
    return {
      ...area,
      issues: area.issues.slice(0, maxIssues).map((issue) => ({
        ...issue,
        quote: issue.quote && content.includes(issue.quote) ? issue.quote : "",
      })),
    };
  };

  return {
    summary: feedback.summary,
    grammar: cleanArea(feedback.grammar),
    evidence: type === "sentence" ? null : cleanArea(feedback.evidence),
    flow: type === "sentence" ? null : cleanArea(feedback.flow),
  };
}

/**
 * "Use AI to analyze for improvements" — operates on the in-progress draft
 * text from DraftReview, before it's ever saved as a Writing.
 */
aiRouter.post("/analyze", analyzeLimiter, async (req, res) => {
  if (!env.OPENAI_API_KEY) {
    throw new HttpError(503, "AI feedback isn't set up yet. Add OPENAI_API_KEY to the server .env file.");
  }

  const { type, content } = bodySchema.parse(req.body);

  // Only successful runs are recorded, so failed OpenAI calls don't eat the allowance.
  const usedToday = await FeedbackRun.countDocuments({
    userId: req.user!._id,
    createdAt: { $gte: startOfToday(timeZoneOf(req)) },
  });
  if (usedToday >= ANALYZE_PER_DAY) {
    throw new HttpError(429, "You've used all of today's AI feedback checks. Keep writing — it resets tomorrow!", {
      limit: ANALYZE_PER_DAY,
      remaining: 0,
    });
  }

  const band = gradeBand(req.user!.gradeLevel);
  const system = [SYSTEM_PROMPT, band ? BAND_NOTE[band] : null, type === "sentence" ? SENTENCE_NOTE : null]
    .filter(Boolean)
    .join("\n\n");

  const raw = await chatJson(
    {
      system,
      user: `Here is my ${type}:\n\n${content}`,
      schemaName: "writing_feedback",
      schema: FEEDBACK_JSON_SCHEMA,
      maxTokens: 900,
      failMessage: FAIL_MESSAGE,
    },
    "ai",
  );

  const result = feedbackSchema.safeParse(raw);
  if (!result.success) {
    console.error("[ai] feedback response didn't match the expected shape", result.error);
    throw new HttpError(502, FAIL_MESSAGE);
  }
  const parsed = result.data;

  const feedback = tidy(parsed, content, type, band === "youngest" ? YOUNGEST_MAX_ISSUES : 3);

  const run = await FeedbackRun.create({
    userId: req.user!._id,
    writingType: type,
    ratings: {
      grammar: feedback.grammar.rating,
      evidence: feedback.evidence?.rating ?? null,
      flow: feedback.flow?.rating ?? null,
    },
    issues: (["grammar", "evidence", "flow"] as const).flatMap((area) =>
      (feedback[area]?.issues ?? []).map((issue) => ({ area, category: issue.category })),
    ),
  });

  res.json({ feedback, runId: run.id as string });
});
