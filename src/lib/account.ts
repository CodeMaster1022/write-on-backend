import type { Types } from "mongoose";
import { ContestEntry } from "../models/Contest.js";
import { FeedbackRun } from "../models/FeedbackRun.js";
import { HelpEvent } from "../models/HelpEvent.js";
import { InkiQuestion } from "../models/InkiQuestion.js";
import { LessonAttempt } from "../models/Lesson.js";
import { EmailLog, EmailVerification, ParentApproval, PasswordReset } from "../models/PasswordReset.js";
import { ReportEmail, ReportShare, ReportSummary } from "../models/ReportShare.js";
import { Revision } from "../models/Revision.js";
import { User } from "../models/User.js";
import { Writing } from "../models/Writing.js";

/** Removes an account and everything saved for it. Used by "Delete my account" and by the admin page. */
export async function deleteAccountData(userId: Types.ObjectId | string): Promise<void> {
  await Promise.all([
    Writing.deleteMany({ userId }),
    Revision.deleteMany({ userId }),
    FeedbackRun.deleteMany({ userId }),
    InkiQuestion.deleteMany({ userId }),
    HelpEvent.deleteMany({ userId }),
    ContestEntry.deleteMany({ userId }),
    LessonAttempt.deleteMany({ userId }),
    ReportShare.deleteMany({ userId }),
    ReportSummary.deleteMany({ userId }),
    ReportEmail.deleteMany({ userId }),
    PasswordReset.deleteMany({ userId }),
    EmailVerification.deleteMany({ userId }),
    ParentApproval.deleteMany({ userId }),
    EmailLog.deleteMany({ userId }),
  ]);
  await User.deleteOne({ _id: userId });
}
