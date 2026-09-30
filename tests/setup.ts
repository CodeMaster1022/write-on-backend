import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { blockedRequests, fakeCloud, fakeFetch, fakeOpenAi, fakeResend } from "./fake-network.js";

// These settings must be in place before the app is imported, and they win
// over server/.env, so a test can never reach the real database or services.
const base = process.env.TEST_MONGO_URI;
if (!base) throw new Error("The in-memory test database isn't running. Run tests with `npm test`.");
const dbUrl = new URL(base);
dbUrl.pathname = `/writeon-test-${randomUUID().slice(0, 8)}`;
if (!["127.0.0.1", "localhost"].includes(dbUrl.hostname)) throw new Error("Tests may only use a local database.");

const ttsDir = mkdtempSync(path.join(os.tmpdir(), "writeon-tts-"));

Object.assign(process.env, {
  NODE_ENV: "test",
  MONGODB_URI: dbUrl.toString(),
  JWT_SECRET: "test-secret-that-is-long-enough",
  CLIENT_ORIGIN: "http://localhost:3000",
  OPENAI_API_KEY: "test-openai-key",
  DEEPGRAM_API_KEY: "",
  EMAIL_API_KEY: "test-email-key",
  CLOUDINARY_URL: "cloudinary://test-key:test-secret@test-cloud",
  EMAIL_FROM: "Write on! <hello@test.example>",
  APP_URL: "https://write-on.test",
  TTS_CACHE_DIR: ttsDir,
});

globalThis.fetch = fakeFetch as typeof fetch;

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI!);
});

beforeEach(() => {
  fakeOpenAi.reset();
  fakeResend.reset();
  fakeCloud.reset();
  blockedRequests.length = 0;
});

afterEach(() => {
  expect(blockedRequests, "the app tried to reach the internet").toEqual([]);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  rmSync(ttsDir, { recursive: true, force: true });
});
