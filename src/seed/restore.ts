/**
 * Loads a backup into a database on the same MongoDB server as MONGODB_URI:
 *   npm run restore -- <backup folder>                       → a new database named "<live name>-restore-<date>"
 *   npm run restore -- <backup folder> --into <name>         → a database you name (must be empty)
 *   npm run restore -- <backup folder> --into <name> --replace
 * Restoring over the live database also needs --i-understand-this-replaces-live-data.
 */
import path from "node:path";
import mongoose from "mongoose";
import { connectDb, disconnectDb } from "../config/db.js";
import { restoreDatabase } from "../lib/backup.js";

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--into");
const into = args.includes("--into") ? args[args.indexOf("--into") + 1] : undefined;
const replace = args.includes("--replace");
const confirmLive = args.includes("--i-understand-this-replaces-live-data");

if (!folder) {
  console.error("Usage: npm run restore -- <backup folder> [--into <database>] [--replace]");
  process.exit(1);
}

await connectDb();
const live = mongoose.connection.db!.databaseName;
const target = into ?? `${live}-restore-${new Date().toISOString().slice(0, 10)}`;

try {
  if (target === live && !confirmLive) {
    throw new Error(`"${target}" is the live database. Restore into another database first, or add --i-understand-this-replaces-live-data.`);
  }
  const db = mongoose.connection.useDb(target, { useCache: false }).db!;
  const restored = await restoreDatabase(db, path.resolve(folder), { replace });
  const total = Object.values(restored).reduce((a, b) => a + b, 0);
  console.log(`[restore] ${total} documents restored into "${target}" and checked against the backup`);
} catch (err) {
  console.error(`[restore] ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
