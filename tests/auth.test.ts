import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ContestEntry } from "../src/models/Contest.js";
import { FeedbackRun } from "../src/models/FeedbackRun.js";
import { HelpEvent } from "../src/models/HelpEvent.js";
import { InkiQuestion } from "../src/models/InkiQuestion.js";
import { ReportShare } from "../src/models/ReportShare.js";
import { User } from "../src/models/User.js";
import { Writing } from "../src/models/Writing.js";
import { fakeOpenAi } from "./fake-network.js";
import { api, bearer, closeContest, createContest, feedbackReply, saveWriting, seedBasics, signUp, signUpAdmin } from "./helpers.js";

beforeAll(seedBasics);

describe("sign-up and sign-in", () => {
  it("creates a student account and returns a session", async () => {
    const res = await api()
      .post("/api/auth/register")
      .send({ displayName: "Mia", email: "mia@test.com", password: "Password123!", parentEmail: "mum@test.com", gradeLevel: "3" });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toMatchObject({ displayName: "Mia", role: "student", gradeLevel: "3", isAdmin: false, parentEmail: "mum@test.com", parentApproved: false });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/i);
  });

  it("never lets sign-up choose the teacher role", async () => {
    const res = await api()
      .post("/api/auth/register")
      .send({ displayName: "T", email: "t@test.com", password: "Password123!", parentEmail: "p@test.com", role: "teacher" });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("student");
  });

  it("refuses a grade outside the list, a short password and a taken email", async () => {
    const grade = await api().post("/api/auth/register").send({ displayName: "A", email: "a@test.com", password: "Password123!", gradeLevel: "third" });
    expect(grade.status).toBe(400);

    const short = await api().post("/api/auth/register").send({ displayName: "A", email: "a@test.com", password: "short" });
    expect(short.status).toBe(400);

    const first = await signUp();
    const taken = await api().post("/api/auth/register").send({ displayName: "B", email: first.email, password: "Password123!", parentEmail: "p@test.com" });
    expect(taken.status).toBe(409);
  });

  it("signs in with the right password only", async () => {
    const user = await signUp();
    const ok = await api().post("/api/auth/login").send({ email: user.email, password: user.password });
    expect(ok.status).toBe(200);
    const bad = await api().post("/api/auth/login").send({ email: user.email, password: "wrong-password" });
    expect(bad.status).toBe(401);
  });

  it("locks sign-in for an email after 10 wrong passwords, without touching other emails", async () => {
    const user = await signUp();
    const other = await signUp();
    for (let i = 0; i < 10; i++) {
      expect((await api().post("/api/auth/login").send({ email: user.email, password: "wrong-password" })).status).toBe(401);
    }
    const locked = await api().post("/api/auth/login").send({ email: user.email, password: user.password });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toContain("wait 15 minutes");
    expect((await api().post("/api/auth/login").send({ email: other.email, password: other.password })).status).toBe(200);
  });

  describe("sign-in log lines", () => {
    afterEach(() => vi.restoreAllMocks());

    it("never include an email address", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const user = await signUp();
      await api().post("/api/auth/login").send({ email: user.email, password: user.password });
      await api().post("/api/auth/login").send({ email: user.email, password: "wrong-password" });
      await api().post("/api/auth/login").send({ email: "nobody@test.com", password: "wrong-password" });

      const lines = log.mock.calls.map((c) => c.join(" ")).filter((l) => l.includes("[auth]"));
      expect(lines).toHaveLength(3);
      expect(lines.join("\n")).not.toContain("@");
      expect(lines[0]).toContain(user.id);
    });
  });

  it("rejects requests without a valid session", async () => {
    expect((await api().get("/api/auth/me")).status).toBe(401);
    expect((await api().get("/api/auth/me").set(bearer("not-a-token"))).status).toBe(401);
  });

  it("no longer makes accounts for guests", async () => {
    expect((await api().post("/api/auth/guest").send({})).status).toBe(404);
    expect((await api().post("/api/auth/claim-guest").send({ email: "a@test.com", password: "Password123!" })).status).toBe(404);
  });

  it("signs out a guest account left over from before, and keeps it out of everything", async () => {
    const created = await api()
      .post("/api/auth/register")
      .send({ displayName: "Old Guest", email: "old-guest@test.com", password: "Password123!", parentEmail: "p@test.com" });
    await User.collection.updateOne({ email: "old-guest@test.com" }, { $set: { isGuest: true } });

    const res = await api().get("/api/auth/me").set(bearer(created.body.token));
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/log in or create an account/);
    expect((await api().post("/api/writings").set(bearer(created.body.token)).send({ type: "sentence", content: "Hi." })).status).toBe(401);
  });

  it("gives every signed-up student a real account, never a guest one", async () => {
    const student = await signUp();
    const me = await api().get("/api/auth/me").set(bearer(student.token));
    expect(me.body.user).not.toHaveProperty("isGuest");
  });
});

describe("download my data", () => {
  it("includes everything saved for the account, and nothing secret", async () => {
    const admin = await signUpAdmin();
    const user = await signUp({ gradeLevel: "5" });
    const contestId = await createContest(admin.token);
    const piece = await saveWriting(user.token, { type: "paragraph", content: "My apple is red.", parts: { contestId } });
    await saveWriting(user.token, { type: "sentence", content: "A free sentence." });
    await api().post(`/api/contests/${contestId}/enter`).set(bearer(user.token)).send({ writingId: piece._id });
    await api().post("/api/events/help").set(bearer(user.token)).send({ kind: "word_help", topic: "noun" });

    // A winner picked but not yet announced must stay hidden in the export too.
    await closeContest(admin.token, contestId);
    const entries = await api().get(`/api/admin/contests/${contestId}/entries`).set(bearer(admin.token));
    const marked = await api()
      .post(`/api/admin/contests/${contestId}/entries/${entries.body.entries[0].id}/winner`)
      .set(bearer(admin.token))
      .send({ isWinner: true });
    expect(marked.status).toBe(200);

    const res = await api().get("/api/auth/me/export").set(bearer(user.token));
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("write-on-my-data.json");
    expect(res.headers["cache-control"]).toBe("no-store");

    const data = res.body;
    expect(data.profile).toMatchObject({ email: user.email, grade: "5", closetItems: ["held-wand"] });
    expect(data.writing).toHaveLength(2);
    expect(data.helpUsed).toHaveLength(1);
    expect(data.contestEntries).toEqual([
      expect.objectContaining({ contest: "Apple Week", writingId: piece._id, winner: null }),
    ]);
    expect(JSON.stringify(data)).not.toMatch(/passwordHash|tokenHash/);
  });

  it("needs a signed-in account", async () => {
    expect((await api().get("/api/auth/me/export")).status).toBe(401);
  });
});

describe("delete my account", () => {
  async function studentWithData() {
    const user = await signUp();
    await saveWriting(user.token, { type: "sentence", content: "The dog runned home." });
    fakeOpenAi.chatReplies.push(feedbackReply());
    await api().post("/api/ai/analyze").set(bearer(user.token)).send({ type: "sentence", content: "The dog runned home." });
    await api().post("/api/inki/define").set(bearer(user.token)).send({ term: "octopus" });
    await api().post("/api/events/help").set(bearer(user.token)).send({ kind: "define", topic: "storm" });
    await api().post("/api/report/shares").set(bearer(user.token)).send({ days: 30 });
    return user;
  }

  async function countsFor(userId: string) {
    const [writings, feedback, inki, help, shares, entries] = await Promise.all([
      Writing.countDocuments({ userId }),
      FeedbackRun.countDocuments({ userId }),
      InkiQuestion.countDocuments({ userId }),
      HelpEvent.countDocuments({ userId }),
      ReportShare.countDocuments({ userId }),
      ContestEntry.countDocuments({ userId }),
    ]);
    return { writings, feedback, inki, help, shares, entries };
  }

  it("keeps everything when the password is wrong", async () => {
    const user = await studentWithData();
    const res = await api().delete("/api/auth/me").set(bearer(user.token)).send({ password: "wrong-password" });
    expect(res.status).toBe(401);
    expect(await countsFor(user.id)).toEqual({ writings: 1, feedback: 1, inki: 1, help: 1, shares: 1, entries: 0 });
    expect(await User.exists({ _id: user.id })).toBeTruthy();
  });

  it("removes the account and everything saved for it", async () => {
    const user = await studentWithData();
    const res = await api().delete("/api/auth/me").set(bearer(user.token)).send({ password: user.password });
    expect(res.status).toBe(204);

    expect(await countsFor(user.id)).toEqual({ writings: 0, feedback: 0, inki: 0, help: 0, shares: 0, entries: 0 });
    expect(await User.exists({ _id: user.id })).toBeNull();
    expect((await api().get("/api/auth/me").set(bearer(user.token))).status).toBe(401);
    expect((await api().post("/api/auth/login").send({ email: user.email, password: user.password })).status).toBe(401);
  });

  it("always needs the password", async () => {
    const user = await signUp();
    expect((await api().delete("/api/auth/me").set(bearer(user.token)).send({})).status).toBe(400);
    expect((await api().delete("/api/auth/me").set(bearer(user.token)).send({ password: "" })).status).toBe(400);
    expect(await User.exists({ _id: user.id })).toBeTruthy();
  });

  it("does not delete an admin account", async () => {
    const admin = await signUpAdmin();
    const res = await api().delete("/api/auth/me").set(bearer(admin.token)).send({ password: admin.password });
    expect(res.status).toBe(400);
    expect(await User.exists({ _id: admin.id })).toBeTruthy();
  });
});
