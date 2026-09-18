import { Schema, model, type InferSchemaType } from "mongoose";

export const WRITING_TYPES = ["sentence", "paragraph", "essay"] as const;
export type WritingType = (typeof WRITING_TYPES)[number];

/** Ink drops a student earns for finishing each kind of writing. */
export const REWARD_PER_TYPE: Record<WritingType, number> = {
  sentence: 5,
  paragraph: 15,
  essay: 30,
};

const writingSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: WRITING_TYPES, required: true, index: true },
    title: { type: String, trim: true, maxlength: 140, default: "" },
    content: { type: String, required: true, maxlength: 20_000 },

    /**
     * The scaffold the student filled in, kept so a teacher can see the
     * choices behind the sentence (article/noun/adjective/verb/adverb, or
     * topic/detail/closing for longer pieces).
     */
    parts: { type: Schema.Types.Mixed, default: {} },

    wordCount: { type: Number, default: 0, min: 0 },
    inkDropsEarned: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

writingSchema.index({ userId: 1, createdAt: -1 });

export type WritingAttrs = InferSchemaType<typeof writingSchema>;
export const Writing = model("Writing", writingSchema);

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
