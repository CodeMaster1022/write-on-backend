import { createHash, randomBytes } from "node:crypto";
import { EmailLog, PasswordReset } from "../models/PasswordReset.js";
import type { UserDoc } from "../models/User.js";
import { appUrl, sendEmail } from "./email.js";
import { passwordResetEmail } from "./emails.js";

const RESET_MINUTES = 60;
export const RESETS_PER_EMAIL_PER_DAY = 3;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export type ResetResult = "sent" | "limit" | "unconfirmed" | "no_email";

/**
 * Emails a one-time password reset link. Unconfirmed addresses get nothing, since the
 * account may have been made with someone else's email. Only the newest link works.
 */
export async function sendPasswordReset(user: UserDoc): Promise<ResetResult> {
  if (!user.email) return "no_email";
  if (user.emailVerified === false) return "unconfirmed";

  const toHash = sha256(user.email);
  const recent = await EmailLog.countDocuments({
    toHash,
    kind: "password_reset",
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });
  if (recent >= RESETS_PER_EMAIL_PER_DAY) return "limit";

  await PasswordReset.deleteMany({ userId: user._id, usedAt: null });
  const token = randomBytes(32).toString("base64url");
  await PasswordReset.create({
    userId: user._id,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + RESET_MINUTES * 60_000),
  });
  await sendEmail({
    to: user.email,
    ...passwordResetEmail(user.displayName, `${appUrl()}/reset-password?token=${token}`),
    failMessage: "Couldn't send the reset email right now. Please try again in a few minutes.",
  });
  await EmailLog.create({ userId: user._id, kind: "password_reset", toHash });
  return "sent";
}
