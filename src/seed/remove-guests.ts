/**
 * Removes the guest accounts made before guests stopped having accounts, with everything saved for them:
 *   npm run remove-guests           → only counts them
 *   npm run remove-guests -- --yes  → deletes them
 * Run it once after deploying. It never touches an account that has an email or a password.
 */
import { connectDb, disconnectDb } from "../config/db.js";
import { deleteAccountData } from "../lib/account.js";
import { User } from "../models/User.js";
import { Writing } from "../models/Writing.js";

const confirmed = process.argv.includes("--yes");

await connectDb();
try {
  const guests = await User.find({ isGuest: true, email: null }).select("_id writingCount").lean();
  const pieces = guests.length ? await Writing.countDocuments({ userId: { $in: guests.map((g) => g._id) } }) : 0;
  console.log(`[guests] ${guests.length} guest ${guests.length === 1 ? "account" : "accounts"}, with ${pieces} ${pieces === 1 ? "piece" : "pieces"} of writing`);

  if (guests.length === 0) {
    console.log("[guests] nothing to remove");
  } else if (!confirmed) {
    console.log("[guests] nothing was deleted. Run again with --yes to delete them.");
  } else {
    for (const g of guests) await deleteAccountData(g._id);
    console.log(`[guests] removed ${guests.length} guest ${guests.length === 1 ? "account" : "accounts"} and everything saved for them`);
  }
} finally {
  await disconnectDb();
}
