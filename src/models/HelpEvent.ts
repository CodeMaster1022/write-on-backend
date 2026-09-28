import { Schema, model, type InferSchemaType } from "mongoose";
import { WRITING_TYPES } from "./Writing.js";

/** word_help = a parts-of-speech help panel; define = a dictionary lookup. */
export const HELP_KINDS = ["word_help", "define"] as const;
export type HelpKind = (typeof HELP_KINDS)[number];

const helpEventSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: HELP_KINDS, required: true },
    // e.g. "noun" for a help panel, or the looked-up word for a definition.
    topic: { type: String, required: true, trim: true, lowercase: true, maxlength: 60 },
    writingType: { type: String, enum: WRITING_TYPES, default: null },
  },
  { timestamps: true },
);

helpEventSchema.index({ userId: 1, createdAt: -1 });

export type HelpEventAttrs = InferSchemaType<typeof helpEventSchema>;
export const HelpEvent = model("HelpEvent", helpEventSchema);
