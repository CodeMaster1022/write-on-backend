import mongoose from "mongoose";
import { beforeAll, describe, expect, it } from "vitest";
import { AdminAction } from "../src/models/AdminAction.js";
import { FeedbackRun } from "../src/models/FeedbackRun.js";
import { InkiQuestion } from "../src/models/InkiQuestion.js";
import { Revision } from "../src/models/Revision.js";
import { User } from "../src/models/User.js";
import { Writing } from "../src/models/Writing.js";
import { fakeOpenAi, fakeResend } from "./fake-network.js";
import { api, bearer, closeContest, createContest, feedbackReply, saveWriting, seedBasics, signUp, signUpAdmin, type TestUser } from "./helpers.js";

let admin: TestUser;

/** Mongoose won't change createdAt through a normal update, so make an account or piece older in the database itself. */
const makeOlder = (collection: "users" | "writings", id: string, daysAgo: number) =>
  mongoose.connection.collection(collection).updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000) } });

beforeAll(async () => {
  await seedBasics();
  admin = await signUpAdmin();
});

const get = (path: string, token = admin.token) => api().get(`/api/admin${path}`).set(bearer(token));

describe("who can use the admin area", () => {
  it("is closed to students and signed-out visitors", async () => {
    const student = await signUp();
    for (const path of ["/overview", "/analytics", "/users", "/activity"]) {
      expect((await get(path, student.token)).status, path).toBe(403);
      expect((await api().get(`/api/admin${path}`)).status, path).toBe(401);
    }
    const victim = await signUp();
    const del = await api().delete(`/api/admin/users/${victim.id}`).set(bearer(student.token)).send({ confirmName: "Sam" });
    expect(del.status).toBe(403);
    expect(await User.exists({ _id: victim.id })).toBeTruthy();
  });
});

describe("overview", () => {
  it("counts students, unconfirmed emails and pieces", async () => {
    const before = (await get("/overview")).body;
    const a = await signUp({ gradeLevel: "3" });
    await signUp({ verified: false });
    await saveWriting(a.token, { type: "paragraph", content: "One piece." });

    const after = (await get("/overview")).body;
    expect(after.totals.students).toBe(before.totals.students + 2);
    expect(after.totals).not.toHaveProperty("guests");
    expect(after.totals.unconfirmed).toBe(before.totals.unconfirmed + 1);
    expect(after.totals.pieces).toBe(before.totals.pieces + 1);
    expect(after.week.newStudents.now).toBe(before.week.newStudents.now + 2);
    expect(after.week.pieces.now).toBe(before.week.pieces.now + 1);
    expect(after.week.activeStudents.now).toBeGreaterThanOrEqual(1);
  });

  it("doesn't count the admin as a student", async () => {
    const before = (await get("/overview")).body.totals.students;
    await signUpAdmin();
    expect((await get("/overview")).body.totals.students).toBe(before);
  });

  it("points out contests waiting for winners and emails nobody confirmed", async () => {
    const contestId = await createContest(admin.token, { title: "Waiting Contest" });
    await closeContest(admin.token, contestId);
    const stale = await signUp({ verified: false });
    await makeOlder("users", stale.id, 5);

    const { attention } = (await get("/overview")).body;
    const keys = attention.map((a: { key: string }) => a.key);
    expect(keys).toContain("judging");
    expect(keys).toContain("unconfirmed");
    expect(attention.find((a: { key: string }) => a.key === "unconfirmed").link).toBe("/app/admin/users?filter=unconfirmed");
  });
});

describe("analytics", () => {
  it("gives a value for every day, and only accepts 7, 30 or 90", async () => {
    const res = await get("/analytics?days=7");
    expect(res.status).toBe(200);
    for (const series of Object.values(res.body.daily) as { date: string; value: number }[][]) expect(series).toHaveLength(7);
    expect((await get("/analytics?days=30")).body.daily.pieces).toHaveLength(30);
    expect((await get("/analytics?days=14")).status).toBe(400);
  });

  it("adds up writing, feedback, Inki and grade groups, without any of the writing", async () => {
    const young = await signUp({ gradeLevel: "1" });
    const old = await signUp({ gradeLevel: "8" });
    await saveWriting(young.token, { type: "sentence", content: "A very private secret sentence.", activeSeconds: 120 });
    await saveWriting(old.token, { type: "essay", content: "Another private essay about my secret dragon.", activeSeconds: 240 });

    fakeOpenAi.chatReplies.push(feedbackReply());
    await api().post("/api/ai/analyze").set(bearer(old.token)).send({ type: "paragraph", content: "Some secret words here." });
    fakeOpenAi.flagged = true;
    await api().post("/api/inki/define").set(bearer(old.token)).send({ term: "badword" });
    fakeOpenAi.flagged = false;

    const res = await get("/analytics?days=7");
    const today = (name: string) => res.body.daily[name].at(-1).value;
    expect(today("pieces")).toBeGreaterThanOrEqual(2);
    expect(today("activeStudents")).toBeGreaterThanOrEqual(2);
    expect(today("aiChecks")).toBeGreaterThanOrEqual(1);
    expect(res.body.writing.byType.find((t: { type: string }) => t.type === "essay").pieces).toBeGreaterThanOrEqual(1);
    expect(res.body.writing.avgMinutes).toBeGreaterThan(0);
    expect(res.body.students.byBand.find((b: { key: string }) => b.key === "youngest").count).toBeGreaterThanOrEqual(1);
    expect(res.body.students.byBand.find((b: { key: string }) => b.key === "oldest").count).toBeGreaterThanOrEqual(1);
    expect(res.body.feedback.checks).toBeGreaterThanOrEqual(1);
    expect(res.body.feedback.topIssues.length).toBeGreaterThan(0);
    expect(res.body.inki.blocked).toBeGreaterThanOrEqual(1);

    const text = JSON.stringify(res.body);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("dragon");
  });

  it("shows how many new students wrote, and came back", async () => {
    const one = await signUp();
    const two = await signUp();
    await signUp();
    const piece = await saveWriting(one.token, { type: "sentence", content: "Day one." });
    const second = await saveWriting(one.token, { type: "sentence", content: "Another day." });
    await makeOlder("writings", second._id, 2);
    await saveWriting(two.token, { type: "sentence", content: "Just once." });
    expect(piece._id).toBeTruthy();

    const { engagement } = (await get("/analytics?days=7")).body;
    expect(engagement.wroteAny).toBeGreaterThanOrEqual(2);
    expect(engagement.wroteTwoDays).toBeGreaterThanOrEqual(1);
    expect(engagement.wroteAnyPercent).toBeLessThanOrEqual(100);
  });
});

describe("user list", () => {
  it("searches by name or email, and never returns passwords", async () => {
    const s = await signUp({ displayName: "Zephyrine Quill" });
    const byName = await get("/users?q=zephyr");
    expect(byName.body.users.map((u: { id: string }) => u.id)).toEqual([s.id]);
    const byEmail = await get(`/users?q=${encodeURIComponent(s.email.slice(0, 14))}`);
    expect(byEmail.body.users.some((u: { id: string }) => u.id === s.id)).toBe(true);
    expect(JSON.stringify(byName.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    expect(byName.body.users[0]).toMatchObject({ name: "Zephyrine Quill", email: s.email, emailConfirmed: true });
  });

  it("treats search text as plain text, not a pattern", async () => {
    const res = await get(`/users?q=${encodeURIComponent(".*")}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
  });

  it("filters students, unconfirmed and inactive accounts, and leaves out old guest accounts", async () => {
    const unconfirmed = await signUp({ displayName: "Unconfirmed Una", verified: false });
    const guest = await signUp({ displayName: "Guesty" });
    await User.collection.updateOne({ email: guest.email }, { $set: { isGuest: true } });
    const idle = await signUp({ displayName: "Idle Ida" });
    await makeOlder("users", idle.id, 60);

    const ids = async (filter: string) => (await get(`/users?filter=${filter}&limit=100`)).body.users.map((u: { id: string }) => u.id);
    expect(await ids("unconfirmed")).toContain(unconfirmed.id);
    expect(await ids("unconfirmed")).not.toContain(idle.id);
    expect((await get("/users?filter=guests")).status).toBe(400);
    expect(await ids("students")).not.toContain(guest.id);
    expect(await ids("inactive")).toContain(idle.id);
    expect(await ids("inactive")).not.toContain(unconfirmed.id);
    expect(await ids("all")).toEqual(expect.arrayContaining([unconfirmed.id, admin.id]));
    expect(await ids("all")).not.toContain(guest.id);
    expect(await ids("students")).not.toContain(admin.id);
  });

  it("pages through 25 at a time", async () => {
    const res = await get("/users?filter=all");
    expect(res.body.pageSize).toBe(25);
    expect(res.body.users.length).toBeLessThanOrEqual(25);
    const second = await get("/users?filter=all&page=2");
    expect(second.body.page).toBe(2);
    if (res.body.total > 25) expect(second.body.users.length).toBeGreaterThan(0);
  });

  it("shows counts for one account, never its writing", async () => {
    const s = await signUp({ displayName: "Detail Dee", gradeLevel: "5" });
    await saveWriting(s.token, { type: "paragraph", content: "Hidden diary words.", activeSeconds: 180 });
    const res = await get(`/users/${s.id}`);
    expect(res.body.user).toMatchObject({ name: "Detail Dee", grade: "5", band: "middle" });
    expect(res.body.counts).toMatchObject({ pieces: 1, words: 3, minutes: 3, feedbackChecks: 0 });
    expect(JSON.stringify(res.body)).not.toContain("diary");
    expect((await get("/users/not-an-id")).status).toBe(404);
  });
});

describe("helping a student", () => {
  it("resends the confirmation email only for an unconfirmed address", async () => {
    const s = await signUp({ verified: false });
    fakeResend.sent = [];
    const ok = await api().post(`/api/admin/users/${s.id}/resend-confirmation`).set(bearer(admin.token));
    expect(ok.status).toBe(200);
    expect(fakeResend.sent.at(-1)).toMatchObject({ to: [s.email], subject: "Confirm your email for Write on!" });

    const confirmed = await signUp();
    const refused = await api().post(`/api/admin/users/${confirmed.id}/resend-confirmation`).set(bearer(admin.token));
    expect(refused.status).toBe(400);

  });

  it("sends a password reset link that works, but not to an unconfirmed address", async () => {
    const s = await signUp();
    fakeResend.sent = [];
    expect((await api().post(`/api/admin/users/${s.id}/password-reset`).set(bearer(admin.token))).status).toBe(200);
    const mail = fakeResend.sent.at(-1)!;
    expect(mail).toMatchObject({ to: [s.email], subject: "Reset your Write on! password" });
    const token = mail.text.match(/reset-password\?token=([\w-]+)/)![1];
    expect((await api().post("/api/auth/reset-password").send({ token, password: "BrandNewPass1!" })).status).toBe(200);

    const unconfirmed = await signUp({ verified: false });
    fakeResend.sent = [];
    const refused = await api().post(`/api/admin/users/${unconfirmed.id}/password-reset`).set(bearer(admin.token));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/isn't confirmed/);
    expect(fakeResend.sent).toHaveLength(0);
  });
});

describe("deleting an account from the admin page", () => {
  async function studentWithData() {
    const s = await signUp({ displayName: "Delete Dan", gradeLevel: "4" });
    const piece = await saveWriting(s.token, { type: "paragraph", content: "Soon gone." });
    await api().patch(`/api/writings/${piece._id}`).set(bearer(s.token)).send({ content: "Soon gone, edited." });
    fakeOpenAi.chatReplies.push(feedbackReply());
    await api().post("/api/ai/analyze").set(bearer(s.token)).send({ type: "paragraph", content: "Words." });
    await api().post("/api/inki/define").set(bearer(s.token)).send({ term: "octopus" });
    return s;
  }
  const remove = (id: string, confirmName: string, token = admin.token) =>
    api().delete(`/api/admin/users/${id}`).set(bearer(token)).send({ confirmName });

  it("needs the student's name typed exactly, and keeps everything if it doesn't match", async () => {
    const s = await studentWithData();
    const res = await remove(s.id, "Someone Else");
    expect(res.status).toBe(400);
    expect(await User.exists({ _id: s.id })).toBeTruthy();
    expect(await Writing.countDocuments({ userId: s.id })).toBe(1);
    expect((await remove(s.id, "")).status).toBe(400);
  });

  it("removes the account and everything saved for it", async () => {
    const s = await studentWithData();
    const res = await remove(s.id, "  delete DAN ");
    expect(res.status).toBe(204);
    expect(await User.exists({ _id: s.id })).toBeNull();
    expect(await Writing.countDocuments({ userId: s.id })).toBe(0);
    expect(await Revision.countDocuments({ userId: s.id })).toBe(0);
    expect(await FeedbackRun.countDocuments({ userId: s.id })).toBe(0);
    expect(await InkiQuestion.countDocuments({ userId: s.id })).toBe(0);
    expect((await api().get("/api/auth/me").set(bearer(s.token))).status).toBe(401);
    expect((await get(`/users/${s.id}`)).status).toBe(404);
  });

  it("won't delete an admin or the admin's own account", async () => {
    const other = await signUpAdmin();
    expect((await remove(other.id, "Erin")).status).toBe(400);
    expect((await remove(admin.id, "Erin")).status).toBe(400);
    expect(await User.exists({ _id: admin.id })).toBeTruthy();
  });
});

describe("activity log", () => {
  it("records what the admin did, without names or emails", async () => {
    const s = await signUp({ displayName: "Logged Lou", gradeLevel: "2", verified: false });
    await api().post(`/api/admin/users/${s.id}/resend-confirmation`).set(bearer(admin.token));
    await api().delete(`/api/admin/users/${s.id}`).set(bearer(admin.token)).send({ confirmName: "Logged Lou" });

    const stored = JSON.stringify(await AdminAction.find({ targetUserId: s.id }).lean());
    expect(stored).not.toContain("Logged");
    expect(stored).not.toContain(s.email);

    const res = await get("/activity");
    const mine = res.body.actions.filter((a: { hasStudent: boolean; note: string | null }) => a.note?.includes("Grade 2"));
    expect(mine[0]).toMatchObject({ kind: "user_delete", admin: "Erin", student: null, hasStudent: true });
    expect(mine[0].note).toBe("Grade 2 student, 0 pieces");
    expect(res.body.actions.some((a: { kind: string }) => a.kind === "user_resend_confirmation")).toBe(true);
  });

  it("shows a student's current name while their account still exists", async () => {
    const s = await signUp({ displayName: "Still Here", verified: false });
    await api().post(`/api/admin/users/${s.id}/resend-confirmation`).set(bearer(admin.token));
    const row = (await get("/activity")).body.actions.find((a: { student: string | null }) => a.student === "Still Here");
    expect(row).toMatchObject({ kind: "user_resend_confirmation", admin: "Erin" });
  });

  it("records contest actions too", async () => {
    const contestId = await createContest(admin.token, { title: "Logged Contest" });
    await api().patch(`/api/admin/contests/${contestId}`).set(bearer(admin.token)).send({ prompt: "A new prompt." });
    const student = await signUp();
    const piece = await saveWriting(student.token, { type: "paragraph", content: "Entry.", parts: { contestId } });
    await api().post(`/api/contests/${contestId}/enter`).set(bearer(student.token)).send({ writingId: piece._id });
    await closeContest(admin.token, contestId);
    const entries = await get(`/contests/${contestId}/entries`);
    const entryId = entries.body.entries[0].id;
    await api().post(`/api/admin/contests/${contestId}/entries/${entryId}/winner`).set(bearer(admin.token)).send({ isWinner: true });
    await api().post(`/api/admin/contests/${contestId}/announce`).set(bearer(admin.token));

    const other = await createContest(admin.token, { title: "Deleted Contest" });
    await api().delete(`/api/admin/contests/${other}`).set(bearer(admin.token));

    const kinds = (await get("/activity")).body.actions
      .filter((a: { contest: string | null }) => a.contest === "Logged Contest" || a.contest === "Deleted Contest")
      .map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["contest_create", "contest_update", "contest_winner_mark", "contest_announce", "contest_delete"]));
  });
});
