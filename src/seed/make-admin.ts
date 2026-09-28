import { connectDb, disconnectDb } from "../config/db.js";
import { User } from "../models/User.js";

/**
 * Gives an existing (non-guest) account access to the contest admin page:
 *   npm run make-admin -- erin@example.com
 * Add --remove to take it away again.
 */
async function main() {
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();
  const remove = args.includes("--remove");
  if (!email) {
    console.error("Usage: npm run make-admin -- <email> [--remove]");
    process.exitCode = 1;
    return;
  }

  await connectDb();
  const user = await User.findOneAndUpdate({ email, isGuest: false }, { isAdmin: !remove }, { new: true });
  if (!user) {
    console.error(`[admin] no account found for ${email}. Sign up in the app first.`);
    process.exitCode = 1;
  } else {
    console.log(`[admin] ${email} is ${user.isAdmin ? "now an admin" : "no longer an admin"}.`);
  }
  await disconnectDb();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDb();
  process.exit(1);
});
