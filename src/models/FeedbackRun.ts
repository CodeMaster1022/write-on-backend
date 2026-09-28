import { Schema, model, type InferSchemaType } from "mongoose";
import { WRITING_TYPES } from "./Writing.js";

export const FEEDBACK_AREAS = ["grammar", "evidence", "flow"] as const;
export type FeedbackArea = (typeof FEEDBACK_AREAS)[number];

/** Fixed list so the progress report can count patterns across many runs. */
export const ISSUE_CATEGORIES = [
  "capitalization",
  "punctuation",
  "spelling",
  "verb_tense",
  "agreement",
  "run_on",
  "fragment",
  "word_choice",
  "needs_reason",
  "needs_example",
  "unsupported_claim",
  "off_topic",
  "needs_transition",
  "order",
  "repetition",
  "sentence_variety",
  "other",
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

/**
 * One "Use AI to analyze" result. Deliberately stores ratings and issue
 * categories only, never the student's draft text.
 */
const feedbackRunSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    writingType: { type: String, enum: WRITING_TYPES, required: true },
    writingId: { type: Schema.Types.ObjectId, ref: "Writing", default: null, index: true },
    ratings: {
      grammar: { type: Number, min: 1, max: 3, required: true },
      evidence: { type: Number, min: 1, max: 3, default: null },
      flow: { type: Number, min: 1, max: 3, default: null },
    },
    issues: {
      type: [
        {
          _id: false,
          area: { type: String, enum: FEEDBACK_AREAS, required: true },
          category: { type: String, enum: ISSUE_CATEGORIES, required: true },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

feedbackRunSchema.index({ userId: 1, createdAt: -1 });

export type FeedbackRunAttrs = InferSchemaType<typeof feedbackRunSchema>;
export const FeedbackRun = model("FeedbackRun", feedbackRunSchema);
