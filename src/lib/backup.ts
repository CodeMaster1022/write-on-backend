import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import mongoose from "mongoose";

const { EJSON } = mongoose.mongo.BSON;
type Db = mongoose.mongo.Db;

const BATCH = 500;

export interface BackupManifest {
  database: string;
  createdAt: string;
  collections: Record<string, number>;
}

/**
 * Writes every collection to `<dir>/<collection>.jsonl.gz`, one document per
 * line in Extended JSON, so ids and dates restore as the same types.
 */
export async function backupDatabase(db: Db, dir: string): Promise<BackupManifest> {
  await mkdir(dir, { recursive: true });
  const collections: Record<string, number> = {};

  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith("system.")) continue;
    let count = 0;
    const cursor = db.collection(name).find();
    const lines = Readable.from(
      (async function* () {
        for await (const doc of cursor) {
          count += 1;
          yield `${EJSON.stringify(doc, { relaxed: false })}\n`;
        }
      })(),
    );
    await pipeline(lines, createGzip(), createWriteStream(path.join(dir, `${name}.jsonl.gz`)));
    collections[name] = count;
  }

  const manifest: BackupManifest = { database: db.databaseName, createdAt: new Date().toISOString(), collections };
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Loads a backup into `db`. Refuses a database that already has data unless
 * `replace` is set, so a restore can't quietly mix with or overwrite live data.
 */
export async function restoreDatabase(db: Db, dir: string, { replace = false } = {}): Promise<Record<string, number>> {
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as BackupManifest;
  const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system."));

  if (existing.length > 0 && !replace) {
    throw new Error(`The "${db.databaseName}" database already has data (${existing.join(", ")}). Restore into a new database, or pass --replace.`);
  }
  if (replace) for (const name of existing) await db.collection(name).drop();

  const restored: Record<string, number> = {};
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl.gz"));
  for (const file of files) {
    const name = file.replace(/\.jsonl\.gz$/, "");
    const collection = db.collection(name);
    const lines = createInterface({ input: createReadStream(path.join(dir, file)).pipe(createGunzip()), crlfDelay: Infinity });
    let batch: mongoose.mongo.Document[] = [];
    let count = 0;
    for await (const line of lines) {
      if (!line.trim()) continue;
      batch.push(EJSON.parse(line, { relaxed: false }) as mongoose.mongo.Document);
      if (batch.length >= BATCH) {
        await collection.insertMany(batch, { ordered: true });
        count += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await collection.insertMany(batch, { ordered: true });
      count += batch.length;
    }
    if (count === 0) await db.createCollection(name).catch(() => {});
    restored[name] = count;
  }

  for (const [name, expected] of Object.entries(manifest.collections)) {
    if ((restored[name] ?? 0) !== expected) {
      throw new Error(`Restore incomplete: ${name} has ${restored[name] ?? 0} documents, the backup had ${expected}.`);
    }
  }
  return restored;
}
