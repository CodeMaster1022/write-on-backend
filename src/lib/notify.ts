import { createHash } from "node:crypto";
import { buildOverview } from "./admin-stats.js";
import { appUrl, sendEmail } from "./email.js";
import { adminDigestEmail, contestResultsEmail, newLessonEmail } from "./emails.js";
import { sendParentApprovalEmail } from "./parent-approval.js";
import { Contest, ContestEntry } from "../models/Contest.js";
import { Lesson } from "../models/Lesson.js";
import { EmailLog } from "../models/PasswordReset.js";
import { RewardItem } from "../models/RewardItem.js";
import { User } from "../models/User.js";

/**
 * Emails the app sends on its own, without a student asking for them. Each
 * one is sent only to confirmed addresses, failures are logged and never
 * stop what caused them, and a log entry stops the same email going twice.
 */

const DAY = 24 * 60 * 60 * 1000;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** A few at a time: Resend accepts a handful of requests per second. */
const BATCH = 5;

type Kind = "contest_results" | "new_lesson" | "admin_digest";

/** Students who can receive email: a parent approved the account, and the address is confirmed. */
const REACHABLE = { isGuest: false, emailVerified: { $ne: false }, email: { $ne: null } };

async function deliver(kind: Kind, recipients: { userId: unknown; to: string; subject: string; text: string; html: string }[]): Promise<number> {
  let sent = 0;
  for (let i = 0; i < recipients.length; i += BATCH) {
    await Promise.all(
      recipients.slice(i, i + BATCH).map(async (r) => {
        try {
          await sendEmail({ to: r.to, subject: r.subject, text: r.text, html: r.html });
          await EmailLog.create({ userId: r.userId, kind, toHash: sha256(r.to) });
          sent += 1;
        } catch (err) {
          console.error(`[notify] couldn't send ${kind} (account ${String(r.userId)})`, err instanceof Error ? err.message : err);
        }
      }),
    );
  }
  return sent;
}

/** After Erin announces the winners: every entrant hears, winners and not. */
export async function notifyContestResults(contestId: unknown): Promise<number> {
  const contest = await Contest.findById(contestId).lean();
  if (!contest?.announcedAt) return 0;
  const entries = await ContestEntry.find({ contestId: contest._id }).select("userId isWinner").lean();
  if (entries.length === 0) return 0;

  const [users, prize] = await Promise.all([
    User.find({ ...REACHABLE, _id: { $in: entries.map((e) => e.userId) }, $or: [{ parentApprovedAt: { $ne: null } }, { isAdmin: true }] })
      .select("displayName email")
      .lean(),
    RewardItem.findOne({ key: contest.prizeKey }).select("name").lean(),
  ]);
  const userById = new Map(users.map((u) => [String(u._id), u]));

  const link = `${appUrl()}/app/contests`;
  const recipients = entries.flatMap((e) => {
    const u = userById.get(String(e.userId));
    if (!u?.email) return [];
    return [{ userId: u._id, to: u.email, ...contestResultsEmail(u.displayName, { title: contest.title, prizeName: prize?.name ?? null }, e.isWinner, link) }];
  });
  return deliver("contest_results", recipients);
}

/**
 * Tells students about a lesson the first time it's found to have started.
 * Claims the lesson first, so two servers can't both send. Lessons that were
 * already replaced by a newer one are marked without an email: nobody wants
 * three "new lesson" emails after a quiet month.
 */
export async function notifyLessonIfDue(): Promise<number> {
  const now = new Date();
  const current = await Lesson.findOne({ startsAt: { $lte: now } }).sort({ startsAt: -1 }).select("_id notifiedAt").lean();
  if (!current) return 0;
  await Lesson.updateMany({ startsAt: { $lte: now }, notifiedAt: null, _id: { $ne: current._id } }, { notifiedAt: now });
  if (current.notifiedAt) return 0;

  const claimed = await Lesson.findOneAndUpdate({ _id: current._id, notifiedAt: null }, { notifiedAt: now }, { new: true }).lean();
  if (!claimed) return 0;

  const students = await User.find({ ...REACHABLE, isAdmin: false, role: "student", parentApprovedAt: { $ne: null }, emailLessons: { $ne: false } })
    .select("displayName email")
    .lean();
  const link = `${appUrl()}/app/lessons/${String(claimed._id)}`;
  return deliver(
    "new_lesson",
    students.flatMap((u) => (u.email ? [{ userId: u._id, to: u.email, ...newLessonEmail(u.displayName, { title: claimed.title }, link) }] : [])),
  );
}

/** One email a day to each admin, only while the overview has something to show. */
export async function sendAdminDigest(): Promise<number> {
  const { attention } = await buildOverview();
  if (attention.length === 0) return 0;

  const admins = await User.find({ isAdmin: true, email: { $ne: null } }).select("displayName email").lean();
  const since = new Date(Date.now() - DAY);
  const recipients = [];
  for (const admin of admins) {
    if (!admin.email) continue;
    const already = await EmailLog.exists({ userId: admin._id, kind: "admin_digest", createdAt: { $gte: since } });
    if (already) continue;
    recipients.push({ userId: admin._id, to: admin.email, ...adminDigestEmail(admin.displayName, attention.map((a) => a.message), `${appUrl()}/app/admin`) });
  }
  return deliver("admin_digest", recipients);
}

/** Three days without an answer: the parent gets the approval email once more. */
export async function remindParents(): Promise<number> {
  const waiting = await User.find({
    isGuest: false,
    isAdmin: false,
    role: "student",
    parentApprovedAt: null,
    parentEmail: { $ne: null },
    parentReminderAt: null,
    createdAt: { $lt: new Date(Date.now() - 3 * DAY) },
  });
  let sent = 0;
  for (const user of waiting) {
    const result = await sendParentApprovalEmail(user);
    if (result === "sent") sent += 1;
    // Mark it either way: a failed or capped send isn't worth retrying every day.
    user.parentReminderAt = new Date();
    await user.save();
  }
  return sent;
}

/** Everything the daily job does. Safe to run more than once a day. */
export async function runDailyJobs() {
  const lessonEmails = await notifyLessonIfDue();
  const parentReminders = await remindParents();
  const adminDigests = await sendAdminDigest();
  return { lessonEmails, parentReminders, adminDigests };
}
