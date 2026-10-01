import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { fakeResend } from "./fake-network.js";
import { RewardItem } from "../src/models/RewardItem.js";
import { User } from "../src/models/User.js";
import { WordBankEntry } from "../src/models/WordBankEntry.js";

export const app = createApp();
export const api = () => request(app);

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export interface TestUser {
  token: string;
  id: string;
  email: string;
  password: string;
}

/**
 * A new student account, approved by its parent unless `approved: false`. Its email is
 * confirmed unless `verified: false`. The emails sign-up sends are cleared, so tests only
 * see the emails they cause.
 */
export async function signUp(
  overrides: { gradeLevel?: string; displayName?: string; verified?: boolean; approved?: boolean } = {},
): Promise<TestUser & { parentEmail: string }> {
  const id = randomUUID().slice(0, 8);
  const email = `student-${id}@test.com`;
  const parentEmail = `parent-${id}@test.com`;
  const password = "Password123!";
  const res = await api()
    .post("/api/auth/register")
    .send({ displayName: overrides.displayName ?? "Sam", email, password, parentEmail, gradeLevel: overrides.gradeLevel ?? "4" });
  if (res.status !== 201) throw new Error(`sign-up failed: ${res.status} ${JSON.stringify(res.body)}`);
  const set: Record<string, unknown> = {};
  if (overrides.verified !== false) set.emailVerified = true;
  if (overrides.approved !== false) set.parentApprovedAt = new Date();
  if (Object.keys(set).length) await User.updateOne({ _id: res.body.user.id }, set);
  fakeResend.sent = fakeResend.sent.filter((m) => !m.to.includes(email) && !m.to.includes(parentEmail));
  return { token: res.body.token, id: res.body.user.id, email, parentEmail, password };
}

export async function signUpAdmin(): Promise<TestUser> {
  const admin = await signUp({ displayName: "Erin" });
  await User.updateOne({ _id: admin.id }, { isAdmin: true });
  return admin;
}

export async function saveWriting(
  token: string,
  body: { type: "sentence" | "paragraph" | "essay"; content: string; parts?: Record<string, unknown>; [k: string]: unknown },
) {
  const res = await api().post("/api/writings").set(bearer(token)).send(body);
  if (res.status !== 201) throw new Error(`save failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.writing as { _id: string; content: string };
}

/** The closet items and word bank entries the tests rely on. */
export async function seedBasics() {
  await RewardItem.updateOne(
    { key: "hat-top" },
    { $set: { key: "hat-top", name: "Top Hat", slot: "hat", cost: 20, art: "topHat", color: "#FF7A5C", blurb: "", sortOrder: 1 } },
    { upsert: true },
  );
  await RewardItem.updateOne(
    { key: "held-wand" },
    {
      $set: { key: "held-wand", name: "Word Wand", slot: "held", cost: 0, art: "wand", color: "#E4577E", blurb: "", sortOrder: 10, exclusive: true },
    },
    { upsert: true },
  );
  await WordBankEntry.updateOne(
    { word: "octopus", partOfSpeech: "noun" },
    { $set: { word: "octopus", partOfSpeech: "noun", meaning: "a sea animal with eight arms", example: "The octopus hid.", tier: 1 } },
    { upsert: true },
  );
}

const HOUR = 60 * 60 * 1000;

export async function createContest(
  adminToken: string,
  overrides: Partial<{ writingType: string; startsAt: Date; endsAt: Date; steps: { question: string; example?: string }[]; title: string }> = {},
) {
  const now = Date.now();
  const res = await api()
    .post("/api/admin/contests")
    .set(bearer(adminToken))
    .send({
      title: overrides.title ?? "Apple Week",
      prompt: "Write about an apple.",
      writingType: overrides.writingType ?? "paragraph",
      startsAt: (overrides.startsAt ?? new Date(now - HOUR)).toISOString(),
      endsAt: (overrides.endsAt ?? new Date(now + HOUR)).toISOString(),
      prizeKey: "held-wand",
      steps: overrides.steps ?? [{ question: "What does your apple look like?" }],
    });
  if (res.status !== 201) throw new Error(`contest create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

export async function closeContest(adminToken: string, contestId: string) {
  const res = await api()
    .patch(`/api/admin/contests/${contestId}`)
    .set(bearer(adminToken))
    .send({ endsAt: new Date(Date.now() - 60_000).toISOString() });
  if (res.status !== 200) throw new Error(`close failed: ${res.status} ${JSON.stringify(res.body)}`);
}

/** A well-formed feedback reply, as OpenAI would return it. */
export function feedbackReply(overrides: Record<string, unknown> = {}) {
  const area = (rating: number, quote = "", category = "punctuation") => ({
    rating,
    praise: "Nice work.",
    issues: [{ quote, suggestion: "Add a period at the end.", category }],
  });
  return {
    summary: "Good start!",
    grammar: area(2, "runned", "verb_tense"),
    evidence: area(1, "", "needs_example"),
    flow: area(3, "", "needs_transition"),
    ...overrides,
  };
}
