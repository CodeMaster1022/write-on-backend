import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ParentApproval } from "../src/models/PasswordReset.js";
import { User } from "../src/models/User.js";
import { Writing } from "../src/models/Writing.js";
import { fakeResend } from "./fake-network.js";
import { api, bearer, seedBasics, signUp, signUpAdmin } from "./helpers.js";

beforeAll(seedBasics);

const linkIn = (text: string, choice: "approve" | "decline") =>
  text.match(new RegExp(String.raw`https://write-on\.test/parent-approval\?token=([A-Za-z0-9_-]+)&choice=${choice}`))?.[1];
const approvalMailTo = (parentEmail: string) =>
  fakeResend.sent.filter((m) => m.to.includes(parentEmail) && m.subject.startsWith("Please approve")).at(-1);

async function register(name = "Ada", grade = "4") {
  const id = randomUUID().slice(0, 8);
  const email = `kid-${id}@test.com`;
  const parentEmail = `parent-${id}@test.com`;
  const res = await api().post("/api/auth/register").send({ displayName: name, email, password: "Password123!", parentEmail, gradeLevel: grade });
  return { res, email, parentEmail, token: res.body.token as string, id: res.body.user.id as string };
}

const write = (token: string) => api().post("/api/writings").set(bearer(token)).send({ type: "sentence", content: "Hello." });

describe("signing up with a parent's email", () => {
  it("needs a parent email, emails the parent, and pauses the account until they approve", async () => {
    const noParent = await api().post("/api/auth/register").send({ displayName: "A", email: "np@test.com", password: "Password123!" });
    expect(noParent.status).toBe(400);

    const { res, email, parentEmail, token } = await register("Ada", "2");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ parentApprovalEmail: "sent", verificationEmail: "sent" });
    expect(res.body.user).toMatchObject({ parentEmail, parentApproved: false });

    const mail = approvalMailTo(parentEmail)!;
    expect(mail.subject).toBe("Please approve Ada's Write on! account");
    expect(mail.text).toContain(`Ada (grade 2) just created a Write on! account using ${email}`);
    expect(mail.text).toContain("https://write-on.test/privacy-policy");
    expect(linkIn(mail.text, "approve")).toBeTruthy();
    expect(linkIn(mail.text, "decline")).toBe(linkIn(mail.text, "approve"));

    // Paused: nothing but the account routes works.
    const blocked = await write(token);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ error: expect.stringContaining(`We emailed ${parentEmail}`), details: { code: "parent_approval_needed" } });
    for (const path of ["/api/lessons", "/api/contests", "/api/progress/me", "/api/inki/status", "/api/rewards"]) {
      expect((await api().get(path).set(bearer(token))).status, path).toBe(403);
    }
    expect((await api().get("/api/auth/me").set(bearer(token))).status).toBe(200);
    expect((await api().get("/api/auth/me/export").set(bearer(token))).status).toBe(200);
  });

  it("unpauses the account when the parent approves, once, from any device", async () => {
    const { parentEmail, token, id } = await register();
    const link = linkIn(approvalMailTo(parentEmail)!.text, "approve")!;
    expect(JSON.stringify(await ParentApproval.find().lean())).not.toContain(link);

    const done = await api().post("/api/auth/parent-approval").send({ token: link, approve: true });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ ok: true, approved: true, studentName: "Ada" });
    expect((await api().get("/api/auth/me").set(bearer(token))).body.user.parentApproved).toBe(true);
    expect((await write(token)).status).toBe(201);
    expect((await User.findById(id).lean())!.parentApprovedAt).toBeInstanceOf(Date);

    expect((await api().post("/api/auth/parent-approval").send({ token: link, approve: true })).status).toBe(400);
  });

  it("deletes the account and everything in it when the parent says no", async () => {
    const { parentEmail, token, id } = await register("Ben");
    const link = linkIn(approvalMailTo(parentEmail)!.text, "decline")!;

    const done = await api().post("/api/auth/parent-approval").send({ token: link, approve: false });
    expect(done.body).toMatchObject({ ok: true, approved: false, studentName: "Ben" });
    expect(await User.findById(id)).toBeNull();
    expect(await Writing.countDocuments({ userId: id })).toBe(0);
    expect((await api().get("/api/auth/me").set(bearer(token))).status).toBe(401);
  });

  it("refuses expired, made-up, and stale links", async () => {
    const { parentEmail } = await register();
    const link = linkIn(approvalMailTo(parentEmail)!.text, "approve")!;
    await ParentApproval.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    expect((await api().post("/api/auth/parent-approval").send({ token: link, approve: true })).status).toBe(400);
    expect((await api().post("/api/auth/parent-approval").send({ token: "x".repeat(43), approve: true })).status).toBe(400);
    expect((await api().post("/api/auth/parent-approval").send({ token: "short", approve: true })).status).toBe(400);
  });

  it("still creates the (paused) account if the email can't be sent", async () => {
    // Both sign-up emails go out at once; the fake fails whichever is sent first.
    fakeResend.failNext = true;
    const { res } = await register();
    expect(res.status).toBe(201);
    expect([res.body.parentApprovalEmail, res.body.verificationEmail]).toContain("failed");
  });
});

describe("fixing the parent's email and sending again", () => {
  it("lets the student correct the address while waiting, which sends a fresh link and voids the old one", async () => {
    const { parentEmail, token } = await register();
    const first = linkIn(approvalMailTo(parentEmail)!.text, "approve")!;

    const fixed = await api().patch("/api/auth/me").set(bearer(token)).send({ parentEmail: "Right.Parent@test.com" });
    expect(fixed.status).toBe(200);
    expect(fixed.body).toMatchObject({ parentApprovalEmail: "sent", user: { parentEmail: "right.parent@test.com" } });
    const second = linkIn(approvalMailTo("right.parent@test.com")!.text, "approve")!;
    expect(second).not.toBe(first);

    // The old link now speaks for the wrong address.
    expect((await api().post("/api/auth/parent-approval").send({ token: first, approve: true })).status).toBe(400);
    expect((await api().post("/api/auth/parent-approval").send({ token: second, approve: true })).status).toBe(200);

    // Once approved, the parent's email is locked.
    expect((await api().patch("/api/auth/me").set(bearer(token)).send({ parentEmail: "other@test.com" })).status).toBe(400);
  });

  it("sends the parent's link again up to 3 times a day", async () => {
    const { token } = await register();
    expect((await api().post("/api/auth/resend-parent-approval").set(bearer(token))).status).toBe(200);
    expect((await api().post("/api/auth/resend-parent-approval").set(bearer(token))).status).toBe(200);
    expect((await api().post("/api/auth/resend-parent-approval").set(bearer(token))).status).toBe(429);
  });

  it("says there's nothing to do for an approved account", async () => {
    const student = await signUp();
    const res = await api().post("/api/auth/resend-parent-approval").set(bearer(student.token));
    expect(res.body.result).toBe("not_needed");
  });
});

describe("accounts from before parent approval existed", () => {
  it("are paused until a parent email is added and the parent approves", async () => {
    const student = await signUp();
    await User.collection.updateOne({ email: student.email }, { $unset: { parentEmail: "", parentApprovedAt: "" } });

    const blocked = await write(student.token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toContain("Add their email on your account page");

    const added = await api().patch("/api/auth/me").set(bearer(student.token)).send({ parentEmail: "late.parent@test.com" });
    expect(added.status).toBe(200);
    const link = linkIn(approvalMailTo("late.parent@test.com")!.text, "approve")!;
    await api().post("/api/auth/parent-approval").send({ token: link, approve: true });
    expect((await write(student.token)).status).toBe(201);
  });

  it("never pauses admins", async () => {
    const admin = await signUpAdmin();
    await User.collection.updateOne({ email: admin.email }, { $unset: { parentEmail: "", parentApprovedAt: "" } });
    expect((await api().get("/api/admin/overview").set(bearer(admin.token))).status).toBe(200);
  });
});

describe("in the admin area", () => {
  it("lists who's waiting, can send the parent's link again, and points out long waits", async () => {
    const admin = await signUpAdmin();
    const waiting = await signUp({ approved: false, displayName: "Waiting Kid" });
    await User.collection.updateOne({ email: waiting.email }, { $set: { createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) } });

    const list = await api().get("/api/admin/users?filter=waiting").set(bearer(admin.token));
    const row = list.body.users.find((u: { email: string }) => u.email === waiting.email);
    expect(row).toMatchObject({ parentApproved: false, parentEmail: waiting.parentEmail });
    const approvedKid = await signUp();
    expect(list.body.users.some((u: { email: string }) => u.email === approvedKid.email)).toBe(false);

    const resend = await api().post(`/api/admin/users/${waiting.id}/resend-parent-approval`).set(bearer(admin.token));
    expect(resend.status).toBe(200);
    expect(approvalMailTo(waiting.parentEmail)).toBeTruthy();

    const overview = await api().get("/api/admin/overview").set(bearer(admin.token));
    const item = overview.body.attention.find((a: { key: string }) => a.key === "waiting");
    expect(item.link).toBe("/app/admin/users?filter=waiting");

    const approved = await signUp();
    expect((await api().post(`/api/admin/users/${approved.id}/resend-parent-approval`).set(bearer(admin.token))).status).toBe(400);
  });
});
