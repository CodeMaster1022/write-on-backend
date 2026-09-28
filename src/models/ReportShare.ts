import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * A read-only link to a student's progress report. Only a SHA-256 hash of
 * the token is stored, so the link can't be rebuilt from the database.
 */
const reportShareSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    periodDays: { type: Number, required: true },
    timeZone: { type: String, default: "UTC" },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const ReportShare = model("ReportShare", reportShareSchema);
export type ReportShareAttrs = InferSchemaType<typeof reportShareSchema>;

/** Cached AI-written summary, keyed by a hash of the numbers it was written from. */
const reportSummarySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    inputHash: { type: String, required: true },
    overview: { type: String, required: true },
    home: { type: [String], default: [] },
    classroom: { type: [String], default: [] },
  },
  { timestamps: true },
);

reportSummarySchema.index({ userId: 1, inputHash: 1 }, { unique: true });
reportSummarySchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const ReportSummary = model("ReportSummary", reportSummarySchema);

/** One emailed report. Counts toward the daily email limit; the recipient address isn't stored. */
const reportEmailSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

reportEmailSchema.index({ userId: 1, createdAt: -1 });

export const ReportEmail = model("ReportEmail", reportEmailSchema);
