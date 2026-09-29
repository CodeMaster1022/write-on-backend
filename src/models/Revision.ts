import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One saved version of a piece of writing. The Writing document always holds
 * the latest text; these keep the history so a student can see how the piece
 * changed and how its AI ratings moved.
 */
const revisionSchema = new Schema(
  {
    writingId: { type: Schema.Types.ObjectId, ref: "Writing", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    content: { type: String, required: true, maxlength: 20_000 },
    wordCount: { type: Number, default: 0, min: 0 },
    /** The AI check made on this exact text, if the student ran one before saving. */
    feedbackRunId: { type: Schema.Types.ObjectId, ref: "FeedbackRun", default: null },
  },
  { timestamps: true },
);

revisionSchema.index({ writingId: 1, createdAt: 1 });

export const MAX_REVISIONS = 50;

export type RevisionAttrs = InferSchemaType<typeof revisionSchema>;
export const Revision = model("Revision", revisionSchema);
