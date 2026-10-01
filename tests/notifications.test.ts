import { beforeAll, describe, expect, it } from "vitest";
import { Lesson } from "../src/models/Lesson.js";
import { EmailLog } from "../src/models/PasswordReset.js";
import { User } from "../src/models/User.js";
import { fakeResend } from "./fake-network.js";
import { api, bearer, closeContest, createContest, saveWriting, seedBasics, signUp, signUpAdmin, type TestUser } from "./helpers.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let admin: TestUser;

beforeAll(async () => {
  await seedBasics();
  admin = await signUpAdmin();
});

const runJobs = () => api().get("/api/jobs/daily").set("Authorization", "Bearer test-cron-secret-long-enough");
const mailTo = (email: string) => fakeResend.sent.filter((m) => m.to.includes(email));

async function enter(student: TestUser, contestId: string) {
  const piece = await saveWriting(student.token, { type: "paragraph", content: "My entry.", parts: { contestId, answers: ["x"] } });
  const res = await api().post(`/api/contests/${contestId}/enter`).set(bearer(student.token)).send({ writingId: piece._id });
  if (res.status !== 200) throw new Error(`enter failed: ${res.status} ${JSON.stringify(res.body)}`);
}

describe("the daily jobs route", () => {
  it("needs the secret", async () => {
    expect((await api().get("/api/jobs/daily")).status).toBe(401);
    expect((await api().get("/api/jobs/daily?key=wrong")).status).toBe(401);
    const ok = await api().get("/api/jobs/daily?key=test-cron-secret-long-enough");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true });
  });
});

describe("contest results", () => {
  it("emails every entrant when winners are announced: winners differently, nobody named, unconfirmed addresses skipped", async () => {
    const contestId = await createContest(admin.token, { title: "Results Week" });
    const winner = await signUp({ displayName: "Win" });
    const other = await signUp({ displayName: "Also" });
    const unconfirmed = await signUp({ verified: false });
    await enter(winner, contestId);
    await enter(other, contestId);
    await enter(unconfirmed, contestId);
    await closeContest(admin.token, contestId);

    const entries = await api().get(`/api/admin/contests/${contestId}/entries`).set(bearer(admin.token));
    const winnerEntry = entries.body.entries.find((e: { student: string }) => e.student === "Win");
    await api().post(`/api/admin/contests/${contestId}/entries/${winnerEntry.id}/winner`).set(bearer(admin.token)).send({ isWinner: true });

    fakeResend.sent = [];
    const announced = await api().post(`/api/admin/contests/${contestId}/announce`).set(bearer(admin.token));
    expect(announced.status).toBe(200);
    expect(announced.body.emailed).toBe(2);

    const toWinner = mailTo(winner.email)[0]!;
    expect(toWinner.subject).toBe("You won Results Week!");
    expect(toWinner.text).toContain("your entry won");
    expect(toWinner.text).toContain("https://write-on.test/app/contests");

    const toOther = mailTo(other.email)[0]!;
    expect(toOther.subject).toBe("The winners of Results Week are announced");
    expect(toOther.text).not.toContain("Win ");
    expect(toOther.text).toContain("Word Wand is still in your closet");

    expect(mailTo(unconfirmed.email)).toHaveLength(0);
    expect(await EmailLog.countDocuments({ kind: "contest_results" })).toBe(2);
  });

  it("still announces when email is down", async () => {
    const contestId = await createContest(admin.token, { title: "Quiet Week" });
    const student = await signUp();
    await enter(student, contestId);
    await closeContest(admin.token, contestId);
    const entries = await api().get(`/api/admin/contests/${contestId}/entries`).set(bearer(admin.token));
    await api().post(`/api/admin/contests/${contestId}/entries/${entries.body.entries[0].id}/winner`).set(bearer(admin.token)).send({ isWinner: true });

    fakeResend.failNext = true;
    const announced = await api().post(`/api/admin/contests/${contestId}/announce`).set(bearer(admin.token));
    expect(announced.status).toBe(200);
    expect(announced.body.emailed).toBe(0);
  });
});

describe("new lesson emails", () => {
  const createLesson = (title: string, startsAt: Date) =>
    api()
      .post("/api/admin/lessons")
      .set(bearer(admin.token))
      .send({ title, teach: "Teach.", startsAt: startsAt.toISOString(), steps: [{ question: "Q", kind: "written" }] });

  it("go to approved, confirmed students who want them, once per lesson, and never for a scheduled lesson", async () => {
    await Lesson.deleteMany({});
    const wants = await signUp({ displayName: "Wants" });
    const optedOut = await signUp();
    await api().patch("/api/auth/me").set(bearer(optedOut.token)).send({ emailLessons: false });
    const waiting = await signUp({ approved: false });
    const unconfirmed = await signUp({ verified: false });

    await createLesson("Future lesson", new Date(Date.now() + DAY));
    fakeResend.sent = [];
    expect((await runJobs()).body.lessonEmails).toBe(0);

    const created = await createLesson("Commas", new Date(Date.now() - HOUR));
    fakeResend.sent = [];
    const run = await runJobs();
    expect(run.body.lessonEmails).toBeGreaterThanOrEqual(1);

    const mail = mailTo(wants.email)[0]!;
    expect(mail.subject).toBe("New lesson: Commas");
    expect(mail.text).toContain(`https://write-on.test/app/lessons/${created.body.id}`);
    expect(mail.text).toContain("Account page");
    expect(mailTo(optedOut.email)).toHaveLength(0);
    expect(mailTo(waiting.email)).toHaveLength(0);
    expect(mailTo(unconfirmed.email)).toHaveLength(0);
    expect(mailTo(admin.email)).toHaveLength(0);

    fakeResend.sent = [];
    expect((await runJobs()).body.lessonEmails).toBe(0);
    expect(fakeResend.sent.filter((m) => m.subject.startsWith("New lesson"))).toHaveLength(0);
  });

  it("a student's visit to the lessons page triggers the email too", async () => {
    await Lesson.deleteMany({});
    const student = await signUp({ displayName: "Visitor" });
    await createLesson("Visited lesson", new Date(Date.now() - HOUR));
    fakeResend.sent = [];
    await api().get("/api/lessons").set(bearer(student.token));
    // The sending happens in the background; give it a moment.
    await new Promise((r) => setTimeout(r, 200));
    expect(mailTo(student.email).some((m) => m.subject === "New lesson: Visited lesson")).toBe(true);
  });

  it("skips lessons that were already replaced before anyone was told", async () => {
    await Lesson.deleteMany({});
    const student = await signUp();
    await createLesson("Old one", new Date(Date.now() - 20 * DAY));
    await createLesson("Newest", new Date(Date.now() - HOUR));
    fakeResend.sent = [];
    await runJobs();
    const subjects = mailTo(student.email).map((m) => m.subject);
    expect(subjects).toContain("New lesson: Newest");
    expect(subjects).not.toContain("New lesson: Old one");
    expect((await Lesson.findOne({ title: "Old one" }).lean())!.notifiedAt).not.toBeNull();
  });
});

describe("the admin digest", () => {
  it("emails the admin once a day while something needs attention", async () => {
    // A student waiting on a parent for 4 days is something to look at.
    const waiting = await signUp({ approved: false });
    await User.collection.updateOne({ email: waiting.email }, { $set: { createdAt: new Date(Date.now() - 4 * DAY) } });

    await EmailLog.deleteMany({ kind: "admin_digest" });
    fakeResend.sent = [];
    const first = await runJobs();
    expect(first.body.adminDigests).toBe(1);
    const mail = mailTo(admin.email).find((m) => m.subject.startsWith("Write on! needs you"))!;
    expect(mail.text).toContain("waiting for a parent");
    expect(mail.text).toContain("https://write-on.test/app/admin");

    fakeResend.sent = [];
    expect((await runJobs()).body.adminDigests).toBe(0);
  });
});

describe("parent reminders", () => {
  it("emails the parent again after 3 days without an answer, once", async () => {
    const fresh = await signUp({ approved: false });
    const stale = await signUp({ approved: false });
    await User.collection.updateOne({ email: stale.email }, { $set: { createdAt: new Date(Date.now() - 4 * DAY) } });

    fakeResend.sent = [];
    const run = await runJobs();
    expect(run.body.parentReminders).toBe(1);
    expect(mailTo(stale.parentEmail)).toHaveLength(1);
    expect(mailTo(fresh.parentEmail)).toHaveLength(0);
    expect((await User.findById(stale.id).lean())!.parentReminderAt).toBeInstanceOf(Date);

    fakeResend.sent = [];
    expect((await runJobs()).body.parentReminders).toBe(0);
  });
});
