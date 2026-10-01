/**
 * Runs the daily jobs once, by hand or from a server cron:
 *   npm run daily-jobs
 * On Vercel the same work runs from the cron in vercel.json instead.
 */
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import { runDailyJobs } from "../lib/notify.js";

await connectDb();
const result = await runDailyJobs();
console.log(`New-lesson emails: ${result.lessonEmails}. Parent reminders: ${result.parentReminders}. Admin digests: ${result.adminDigests}.`);
await mongoose.disconnect();
