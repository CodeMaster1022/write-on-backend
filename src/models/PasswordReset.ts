import { Schema, model } from "mongoose";

/**
 * A password reset link. Only a SHA-256 hash of the link's token is stored,
 * so the link can't be rebuilt from the database. MongoDB deletes each one
 * automatically once it has expired.
 */
const passwordResetSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordReset = model("PasswordReset", passwordResetSchema);

/** A "confirm your email" link. Same rules as a reset link: only a hash is stored, and it expires. */
const emailVerificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    email: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

emailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailVerification = model("EmailVerification", emailVerificationSchema);

/** A parent's "approve this account" link. One link carries both choices (approve, or say no and delete). */
const parentApprovalSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    parentEmail: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

parentApprovalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ParentApproval = model("ParentApproval", parentApprovalSchema);

/**
 * A parent's link to the upgrade page, sent by email. It works for 7 days and
 * more than once (a parent may come back to it), and only opens Stripe's pages.
 */
const billingLinkSchema = new Schema(
  {
    familyId: { type: Schema.Types.ObjectId, ref: "Family", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

billingLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BillingLink = model("BillingLink", billingLinkSchema);

/**
 * One email the app sent, for daily limits. Stores what kind it was and a
 * hash of the address it went to, never the address or the message itself.
 * Deleted automatically after two days.
 */
const emailLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    kind: {
      type: String,
      enum: ["writing_copy", "password_reset", "verify_email", "parent_approval", "contest_results", "new_lesson", "admin_digest", "upgrade_link", "payment_failed"],
      required: true,
    },
    toHash: { type: String, required: true },
  },
  { timestamps: true },
);

emailLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 24 * 60 * 60 });
emailLogSchema.index({ toHash: 1, kind: 1, createdAt: -1 });

export const EmailLog = model("EmailLog", emailLogSchema);
