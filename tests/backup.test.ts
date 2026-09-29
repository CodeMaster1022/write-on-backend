import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { afterAll, describe, expect, it } from "vitest";
import { backupDatabase, restoreDatabase } from "../src/lib/backup.js";
import { api, bearer, saveWriting, seedBasics, signUp } from "./helpers.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "writeon-backup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("backup and restore", () => {
  it("restores an exact copy into a separate database", async () => {
    await seedBasics();
    const student = await signUp({ displayName: "Rosa" });
    const piece = await saveWriting(student.token, { type: "paragraph", content: "Backups keep stories safe." });
    await api().put("/api/progress/goal").set(bearer(student.token)).send({ perWeek: 3 });

    const live = mongoose.connection.db!;
    const manifest = await backupDatabase(live, dir);
    expect(manifest.collections.writings).toBe(1);
    expect(manifest.collections.users).toBeGreaterThan(0);

    const copy = mongoose.connection.useDb(`${live.databaseName}-restore`, { useCache: false }).db!;
    const restored = await restoreDatabase(copy, dir);
    expect(restored).toEqual(manifest.collections);

    // Same documents, with ids and dates still their real types.
    const original = await live.collection("writings").findOne({});
    const back = await copy.collection("writings").findOne({});
    expect(back).toEqual(original);
    expect(back!._id).toBeInstanceOf(mongoose.mongo.ObjectId);
    expect(back!.createdAt).toBeInstanceOf(Date);
    expect(String(back!._id)).toBe(piece._id);

    const user = await copy.collection("users").findOne({ displayName: "Rosa" });
    expect(user!.goalHistory).toHaveLength(1);
    expect(user!.passwordHash).toBe((await live.collection("users").findOne({ displayName: "Rosa" }))!.passwordHash);

    await copy.dropDatabase();
  });

  it("refuses to restore over a database that already has data", async () => {
    const live = mongoose.connection.db!;
    await expect(restoreDatabase(live, dir)).rejects.toThrow(/already has data/);
    expect(await live.collection("writings").countDocuments()).toBe(1);
  });

  it("replaces a database only when asked to", async () => {
    const other = mongoose.connection.useDb(`${mongoose.connection.db!.databaseName}-replace`, { useCache: false }).db!;
    await other.collection("writings").insertOne({ content: "old data" });
    await restoreDatabase(other, dir, { replace: true });
    expect(await other.collection("writings").countDocuments({ content: "old data" })).toBe(0);
    expect(await other.collection("writings").countDocuments()).toBe(1);
    await other.dropDatabase();
  });
});
