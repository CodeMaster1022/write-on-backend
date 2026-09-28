import { connectDb, disconnectDb } from "../config/db.js";
import { normalizeGrade } from "../config/grades.js";
import { User } from "../models/User.js";

/**
 * One-time cleanup after grade level became a fixed list. Converts values
 * like "3rd" to "3". Values it can't read are left as they are and listed,
 * so nothing is lost; those students get the middle Inki limit until they
 * pick a grade on the Account page.
 */
async function main() {
  await connectDb();

  const users = await User.find({ gradeLevel: { $nin: [null, ""] } }).select("gradeLevel").lean();
  let changed = 0;
  let unreadable = 0;

  for (const user of users) {
    const next = normalizeGrade(user.gradeLevel);
    if (next === user.gradeLevel) continue;

    if (next === null) {
      unreadable += 1;
      console.log(`[grades] left as-is (couldn't read): "${user.gradeLevel}"`);
    } else {
      await User.updateOne({ _id: user._id }, { gradeLevel: next });
      changed += 1;
      console.log(`[grades] "${user.gradeLevel}" -> "${next}"`);
    }
  }

  console.log(`[grades] checked ${users.length}, converted ${changed}, left as-is ${unreadable}`);
  await disconnectDb();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDb();
  process.exit(1);
});
