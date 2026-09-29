/**
 * Saves a copy of the whole database:
 *   npm run backup                 → backups/<database>-<date>/
 *   npm run backup -- <folder>     → the folder you choose
 * The copy holds children's writing: keep it somewhere private and encrypted, never in git.
 */
import path from "node:path";
import mongoose from "mongoose";
import { connectDb, disconnectDb } from "../config/db.js";
import { backupDatabase } from "../lib/backup.js";

await connectDb();
const db = mongoose.connection.db!;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = path.resolve(process.argv[2] ?? path.join("backups", `${db.databaseName}-${stamp}`));

try {
  const manifest = await backupDatabase(db, dir);
  const total = Object.values(manifest.collections).reduce((a, b) => a + b, 0);
  console.log(`[backup] ${total} documents from ${Object.keys(manifest.collections).length} collections saved to ${dir}`);
} finally {
  await disconnectDb();
}
