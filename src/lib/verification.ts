import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "../middleware/error.js";
import { EmailLog, EmailVerification } from "../models/PasswordReset.js";
import type { UserDoc } from "../models/User.js";
import { appUrl, sendEmail } from "./email.js";
import { verifyEmailEmail } from "./emails.js";

const LINK_HOURS = 48;
export const VERIFY_EMAILS_PER_DAY = 3;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export type SendResult = "sent" | "limit" | "failed" | "not_needed";

/**
 * Sends a "confirm your email" link. Never throws: a problem with email must
 * not stop someone from signing up, and the banner lets them try again.
 */
export async function sendVerificationEmail(user: UserDoc): Promise<SendResult> {
  if (!user.email || user.emailVerified) return "not_needed";

  const sentToday = await EmailLog.countDocuments({
    userId: user._id,
    kind: "verify_email",
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });
  if (sentToday >= VERIFY_EMAILS_PER_DAY) return "limit";

  // Only the newest link works.
  await EmailVerification.deleteMany({ userId: user._id });
  const token = randomBytes(32).toString("base64url");
  await EmailVerification.create({
    userId: user._id,
    email: user.email,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + LINK_HOURS * 60 * 60 * 1000),
  });

  try {
    await sendEmail({ to: user.email, ...verifyEmailEmail(user.displayName, `${appUrl()}/verify-email?token=${token}`) });
  } catch (err) {
    console.error(`[auth] couldn't send the confirmation email (account ${user.id})`, err instanceof Error ? err.message : err);
    return "failed";
  }
  await EmailLog.create({ userId: user._id, kind: "verify_email", toHash: sha256(user.email) });
  return "sent";
}

/** Marks the email confirmed if the link is valid. Returns the user id, or null. */
export async function claimVerificationLink(token: string): Promise<{ userId: string; email: string } | null> {
  const link = await EmailVerification.findOneAndDelete({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } });
  return link ? { userId: String(link.userId), email: link.email } : null;
}

/** For features that send email: only confirmed accounts may use them. */
export function requireVerifiedEmail(user: UserDoc) {
  if (!user.email) throw new HttpError(403, "You need an account with an email before you can send emails.");
  if (user.emailVerified === false) {
    throw new HttpError(403, `Please confirm your email first. We sent a link to ${user.email}. You can send it again from the reminder at the top of the page.`);
  }
}
