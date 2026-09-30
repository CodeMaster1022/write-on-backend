import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { EmailVerification } from "../src/models/PasswordReset.js";
import { User } from "../src/models/User.js";
import { fakeResend } from "./fake-network.js";
import { api, bearer, saveWriting, seedBasics, signUp } from "./helpers.js";

beforeAll(seedBasics);

const tokenIn = (text: string) => text.match(/https:\/\/write-on\.test\/verify-email\?token=([A-Za-z0-9_-]+)/)?.[1];
const confirmationFor = (email: string) =>
  fakeResend.sent.filter((m) => m.to.includes(email) && m.subject === "Confirm your email for Write on!").at(-1);

async function register(name = "Ada") {
  const email = `new-${randomUUID().slice(0, 8)}@test.com`;
  const res = await api().post("/api/auth/register").send({ displayName: name, email, password: "Password123!", gradeLevel: "4" });
  return { res, email, token: res.body.token as string };
}

describe("confirming the email at sign-up", () => {
  it("sends a confirmation link, and the student can write straight away", async () => {
    const { res, email, token } = await register("Ada");
    expect(res.status).toBe(201);
    expect(res.body.user.emailVerified).toBe(false);
    expect(res.body.verificationEmail).toBe("sent");

    const mail = confirmationFor(email)!;
    expect(mail.text).toContain("Hi Ada");
    expect(tokenIn(mail.text)).toBeTruthy();

    // Writing works before confirming.
    const piece = await api().post("/api/writings").set(bearer(token)).send({ type: "sentence", content: "I can write already." });
    expect(piece.status).toBe(201);
  });

  it("confirms the email once, from any device", async () => {
    const { email, token } = await register();
    const link = tokenIn(confirmationFor(email)!.text)!;
    expect(JSON.stringify(await EmailVerification.find().lean())).not.toContain(link);

    const done = await api().post("/api/auth/verify-email").send({ token: link });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ ok: true, email });
    expect((await api().get("/api/auth/me").set(bearer(token))).body.user.emailVerified).toBe(true);

    const again = await api().post("/api/auth/verify-email").send({ token: link });
    expect(again.status).toBe(400);
  });

  it("refuses expired and made-up links", async () => {
    const { email } = await register();
    const link = tokenIn(confirmationFor(email)!.text)!;
    await EmailVerification.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    expect((await api().post("/api/auth/verify-email").send({ token: link })).status).toBe(400);
    expect((await api().post("/api/auth/verify-email").send({ token: "x".repeat(43) })).status).toBe(400);
    expect((await api().post("/api/auth/verify-email").send({ token: "short" })).status).toBe(400);
  });

  it("still creates the account if the email can't be sent", async () => {
    fakeResend.failNext = true;
    const { res } = await register();
    expect(res.status).toBe(201);
    expect(res.body.verificationEmail).toBe("failed");
  });
});

describe("sending the link again", () => {
  it("works up to 3 times a day, and only the newest link works", async () => {
    const { email, token } = await register();
    const first = tokenIn(confirmationFor(email)!.text)!;

    expect((await api().post("/api/auth/resend-verification").set(bearer(token))).status).toBe(200);
    const second = tokenIn(confirmationFor(email)!.text)!;
    expect(second).not.toBe(first);
    expect((await api().post("/api/auth/verify-email").send({ token: first })).status).toBe(400);

    expect((await api().post("/api/auth/resend-verification").set(bearer(token))).status).toBe(200);
    const fourth = await api().post("/api/auth/resend-verification").set(bearer(token));
    expect(fourth.status).toBe(429);
  });

  it("says there's nothing to do for a confirmed account", async () => {
    const student = await signUp();
    const res = await api().post("/api/auth/resend-verification").set(bearer(student.token));
    expect(res.body.result).toBe("not_needed");
    expect(fakeResend.sent).toHaveLength(0);
  });
});

describe("before the email is confirmed", () => {
  it("the app won't send any email for the account", async () => {
    const student = await signUp({ verified: false });
    fakeResend.sent = [];
    const piece = await saveWriting(student.token, { type: "sentence", content: "Hi." });

    const copy = await api().post(`/api/writings/${piece._id}/email`).set(bearer(student.token)).send({ to: "x@test.com" });
    expect(copy.status).toBe(403);
    expect(copy.body.error).toMatch(/confirm your email/);

    const report = await api().post("/api/report/email").set(bearer(student.token)).send({ to: "x@test.com", days: 7 });
    expect(report.status).toBe(403);

    // Forgot password answers the same way, but sends nothing to an unconfirmed address.
    const forgot = await api().post("/api/auth/forgot-password").send({ email: student.email });
    expect(forgot.status).toBe(200);
    expect(fakeResend.sent).toHaveLength(0);
  });
});

describe("accounts from before confirmation existed", () => {
  it("count as confirmed", async () => {
    const student = await signUp({ verified: false });
    await User.collection.updateOne({ email: student.email }, { $unset: { emailVerified: "" } });
    const me = await api().get("/api/auth/me").set(bearer(student.token));
    expect(me.body.user.emailVerified).toBe(true);
  });
});
