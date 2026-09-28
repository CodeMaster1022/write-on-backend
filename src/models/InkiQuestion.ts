import { Schema, model, type InferSchemaType } from "mongoose";
import { WRITING_TYPES } from "./Writing.js";

export const INKI_KINDS = ["define", "check"] as const;
export type InkiKind = (typeof INKI_KINDS)[number];

export const INKI_ELEMENTS = ["answered_question", "evidence", "transitions", "tone"] as const;
export type InkiElement = (typeof INKI_ELEMENTS)[number];

export const INKI_VERDICTS = ["yes", "partly", "not_yet"] as const;
export type InkiVerdict = (typeof INKI_VERDICTS)[number];

/**
 * One use of helper Inki. Also counts toward the daily limit. Stores the
 * choice made and the word defined, never the student's draft.
 */
const inkiQuestionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: INKI_KINDS, required: true },
    element: { type: String, enum: INKI_ELEMENTS, default: null },
    term: { type: String, trim: true, lowercase: true, maxlength: 40, default: null },
    verdict: { type: String, enum: INKI_VERDICTS, default: null },
    blocked: { type: Boolean, default: false },
    writingType: { type: String, enum: WRITING_TYPES, default: null },
  },
  { timestamps: true },
);

inkiQuestionSchema.index({ userId: 1, createdAt: -1 });

export type InkiQuestionAttrs = InferSchemaType<typeof inkiQuestionSchema>;
export const InkiQuestion = model("InkiQuestion", inkiQuestionSchema);
