import { Schema, model } from "mongoose";

export const ADMIN_ACTIONS = [
  "user_delete",
  "user_reset_password",
  "user_resend_confirmation",
  "contest_create",
  "contest_update",
  "contest_delete",
  "contest_winner_mark",
  "contest_winner_unmark",
  "contest_announce",
] as const;
export type AdminActionKind = (typeof ADMIN_ACTIONS)[number];

/**
 * One thing an admin did. Deliberately holds no student names or emails: only the
 * account's id and a short non-identifying note (for example "4th grade student"),
 * so the log stays useful after an account is deleted. Deleted after a year.
 */
const adminActionSchema = new Schema(
  {
    adminId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: ADMIN_ACTIONS, required: true },
    targetUserId: { type: Schema.Types.ObjectId, default: null },
    contestTitle: { type: String, default: null, maxlength: 80 },
    note: { type: String, default: null, maxlength: 120 },
  },
  { timestamps: true },
);

adminActionSchema.index({ createdAt: -1 });
adminActionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

export const AdminAction = model("AdminAction", adminActionSchema);
