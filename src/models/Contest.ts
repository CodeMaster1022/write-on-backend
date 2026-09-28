import { Schema, model, type InferSchemaType } from "mongoose";
import { WRITING_TYPES } from "./Writing.js";

const contestSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 80 },
    /** What to write about, e.g. "Write a paragraph about a haunted place." */
    prompt: { type: String, required: true, trim: true, maxlength: 400 },
    writingType: { type: String, enum: WRITING_TYPES, required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true, index: true },
    /** Key of an exclusive RewardItem that every entrant receives. */
    prizeKey: { type: String, required: true },
    /** Set when Erin announces the winners; winners only see their badge after this. */
    announcedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

export type ContestAttrs = InferSchemaType<typeof contestSchema>;
export const Contest = model("Contest", contestSchema);

export type ContestStatus = "upcoming" | "open" | "judging" | "announced";

export function contestStatus(c: { startsAt: Date; endsAt: Date; announcedAt?: Date | null }, now = new Date()): ContestStatus {
  if (c.announcedAt) return "announced";
  if (now < c.startsAt) return "upcoming";
  if (now <= c.endsAt) return "open";
  return "judging";
}

/** One student's entry. A student has at most one entry per contest (entering again swaps the piece). */
const contestEntrySchema = new Schema(
  {
    contestId: { type: Schema.Types.ObjectId, ref: "Contest", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    writingId: { type: Schema.Types.ObjectId, ref: "Writing", required: true },
    isWinner: { type: Boolean, default: false },
    /** When the winner saw their celebration screen. */
    winnerSeenAt: { type: Date, default: null },
  },
  { timestamps: true },
);

contestEntrySchema.index({ contestId: 1, userId: 1 }, { unique: true });
contestEntrySchema.index({ contestId: 1, createdAt: 1 });

export type ContestEntryAttrs = InferSchemaType<typeof contestEntrySchema>;
export const ContestEntry = model("ContestEntry", contestEntrySchema);
