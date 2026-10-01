import { createHash, randomBytes } from "node:crypto";
import { normalizeGrade } from "../config/grades.js";
import { EmailLog, ParentApproval } from "../models/PasswordReset.js";
import type { UserDoc } from "../models/User.js";
import { appUrl, sendEmail } from "./email.js";
import { parentApprovalEmail } from "./emails.js";
import type { SendResult } from "./verification.js";

const LINK_DAYS = 7;
export const PARENT_EMAILS_PER_DAY = 3;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Where a parent lands from the email; the token is read by the page and sent back with their choice. */
export const parentApprovalLink = (token: string, choice: "approve" | "decline") =>
  `${appUrl()}/parent-approval?token=${token}&choice=${choice}`;

/**
 * Emails the parent an approve/decline link. Never throws: the account still
 * exists (paused) if email is down, and the hold screen lets the student try again.
 */
export async function sendParentApprovalEmail(user: UserDoc): Promise<SendResult> {
  if (!user.parentEmail || user.parentApprovedAt || !user.email) return "not_needed";

  const sentToday = await EmailLog.countDocuments({
    userId: user._id,
    kind: "parent_approval",
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });
  if (sentToday >= PARENT_EMAILS_PER_DAY) return "limit";

  // Only the newest link works.
  await ParentApproval.deleteMany({ userId: user._id });
  const token = randomBytes(32).toString("base64url");
  await ParentApproval.create({
    userId: user._id,
    parentEmail: user.parentEmail,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + LINK_DAYS * 24 * 60 * 60 * 1000),
  });

  try {
    await sendEmail({
      to: user.parentEmail,
      ...parentApprovalEmail(
        { name: user.displayName, email: user.email, grade: normalizeGrade(user.gradeLevel) },
        { approve: parentApprovalLink(token, "approve"), decline: parentApprovalLink(token, "decline"), policy: `${appUrl()}/privacy-policy` },
      ),
    });
  } catch (err) {
    console.error(`[auth] couldn't send the parent approval email (account ${user.id})`, err instanceof Error ? err.message : err);
    return "failed";
  }
  await EmailLog.create({ userId: user._id, kind: "parent_approval", toHash: sha256(user.parentEmail) });
  return "sent";
}

/** Uses up the link if it's valid. Returns who it was for, or null. */
export async function claimParentLink(token: string): Promise<{ userId: string; parentEmail: string } | null> {
  const link = await ParentApproval.findOneAndDelete({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } });
  return link ? { userId: String(link.userId), parentEmail: link.parentEmail } : null;
}
