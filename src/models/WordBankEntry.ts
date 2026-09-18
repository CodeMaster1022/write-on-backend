import { Schema, model, type InferSchemaType } from "mongoose";

export const PARTS_OF_SPEECH = ["noun", "verb", "adjective", "adverb", "article"] as const;
export type PartOfSpeech = (typeof PARTS_OF_SPEECH)[number];

const wordBankSchema = new Schema(
  {
    word: { type: String, required: true, trim: true, maxlength: 40 },
    partOfSpeech: { type: String, enum: PARTS_OF_SPEECH, required: true, index: true },

    /** Kid-facing gloss, e.g. "very big". Kept short on purpose. */
    meaning: { type: String, trim: true, maxlength: 160, default: "" },
    /** A model sentence showing the word in use. */
    example: { type: String, trim: true, maxlength: 240, default: "" },

    /** 1 = early reader, 2 = developing, 3 = stretch vocabulary. */
    tier: { type: Number, min: 1, max: 3, default: 1, index: true },
  },
  { timestamps: true },
);

wordBankSchema.index({ word: 1, partOfSpeech: 1 }, { unique: true });

export type WordBankAttrs = InferSchemaType<typeof wordBankSchema>;
export const WordBankEntry = model("WordBankEntry", wordBankSchema);
