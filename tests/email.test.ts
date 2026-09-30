import { vi, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EmailLog, PasswordReset } from "../src/models/PasswordReset.js";
import { fakeResend } from "./fake-network.js";
import { api, bearer, saveWriting, seedBasics, signUp } from "./helpers.js";

beforeAll(seedBasics);
afterEach(() => vi.restoreAllMocks());

const forgot = (email: string) => api().post("/api/auth/forgot-password").send({ email });
const reset = (token: string, password: string) => api().post("/api/auth/reset-password").send({ token, password });
const linkIn = (text: string) => text.match(/https:\/\/write-on\.test\/reset-password\?token=([A-Za-z0-9_-]+)/)?.[1];

describe("forgot password", () => {
  it("emails a one-time link, and the new password works", async () => {
    const student = await signUp({ displayName: "Omar" });
    const res = await forgot(student.email.toUpperCase());
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/If an account uses that email/);

    const mail = fakeResend.sent.at(-1)!;
    expect(mail.to).toEqual([student.email]);
    expect(mail.subject).toBe("Reset your Write on! password");
    expect(mail.text).toContain("Hi Omar");
    const token = linkIn(mail.text)!;
    expect(token).toBeTruthy();
    expect(mail.html).toContain(token);

    // Only a hash of the link is stored.
    expect(JSON.stringify(await PasswordReset.find().lean())).not.toContain(token);

    const done = await reset(token, "BrandNewPass1!");
    expect(done.status).toBe(200);
    expect(done.body.token).toBeTruthy();
    expect((await api().get("/api/auth/me").set(bearer(done.body.token))).status).toBe(200);

    expect((await api().post("/api/auth/login").send({ email: student.email, password: "BrandNewPass1!" })).status).toBe(200);
    expect((await api().post("/api/auth/login").send({ email: student.email, password: student.password })).status).toBe(401);
  });

  it("signs out every other device", async () => {
    const student = await signUp();
    expect((await api().get("/api/auth/me").set(bearer(student.token))).status).toBe(200);
    await forgot(student.email);
    await reset(linkIn(fakeResend.sent.at(-1)!.text)!, "BrandNewPass1!");

    const old = await api().get("/api/auth/me").set(bearer(student.token));
    expect(old.status).toBe(401);
    expect(old.body.error).toMatch(/password was changed/);
  });

  it("works once only", async () => {
    const student = await signUp();
    await forgot(student.email);
    const token = linkIn(fakeResend.sent.at(-1)!.text)!;
    expect((await reset(token, "FirstNewPass1!")).status).toBe(200);
    const again = await reset(token, "SecondNewPass1!");
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/expired or was already used/);
  });

  it("expires after an hour", async () => {
    const student = await signUp();
    await forgot(student.email);
    const token = linkIn(fakeResend.sent.at(-1)!.text)!;
    await PasswordReset.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    expect((await reset(token, "BrandNewPass1!")).status).toBe(400);
  });

  it("only lets the newest link work", async () => {
    const student = await signUp();
    await forgot(student.email);
    const first = linkIn(fakeResend.sent.at(-1)!.text)!;
    await forgot(student.email);
    const second = linkIn(fakeResend.sent.at(-1)!.text)!;
    expect((await reset(first, "BrandNewPass1!")).status).toBe(400);
    expect((await reset(second, "BrandNewPass1!")).status).toBe(200);
  });

  it("gives the same answer for an address with no account, and sends nothing", async () => {
    const res = await forgot("nobody-here@test.com");
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/If an account uses that email/);
    expect(fakeResend.sent).toHaveLength(0);
  });

  it("sends at most 3 emails a day to one address", async () => {
    const student = await signUp();
    for (let i = 0; i < 5; i++) expect((await forgot(student.email)).status).toBe(200);
    expect(fakeResend.sent).toHaveLength(3);
    // The address itself isn't stored.
    expect(JSON.stringify(await EmailLog.find().lean())).not.toContain(student.email);
  });

  it("refuses a short password and a made-up link", async () => {
    const student = await signUp();
    await forgot(student.email);
    const token = linkIn(fakeResend.sent.at(-1)!.text)!;
    expect((await reset(token, "short")).status).toBe(400);
    expect((await reset("x".repeat(43), "BrandNewPass1!")).status).toBe(400);
    expect((await reset("not-a-token", "BrandNewPass1!")).status).toBe(400);
  });

  it("keeps the email address out of the logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const student = await signUp();
    await forgot(student.email);
    await reset(linkIn(fakeResend.sent.at(-1)!.text)!, "BrandNewPass1!");
    expect(log.mock.calls.flat().join(" ")).not.toContain("@");
  });
});

describe("email me a copy", () => {
  it("sends the piece to the address given, and doesn't keep the address", async () => {
    const student = await signUp({ displayName: "Nia" });
    const piece = await saveWriting(student.token, { type: "paragraph", title: "My garden", content: "Tomatoes grow <fast> in summer." });

    const res = await api().post(`/api/writings/${piece._id}/email`).set(bearer(student.token)).send({ to: "Grandma@Example.com" });
    expect(res.status).toBe(204);

    const mail = fakeResend.sent.at(-1)!;
    expect(mail.to).toEqual(["grandma@example.com"]);
    expect(mail.subject).toBe("Nia's paragraph from Write on!");
    expect(mail.text).toContain("Tomatoes grow <fast> in summer.");
    // Student text is escaped in the HTML version.
    expect(mail.html).toContain("Tomatoes grow &lt;fast&gt; in summer.");
    expect(JSON.stringify(await EmailLog.find({ userId: student.id }).lean())).not.toContain("grandma");
  });

  it("only sends the student's own writing", async () => {
    const owner = await signUp();
    const other = await signUp();
    const piece = await saveWriting(owner.token, { type: "sentence", content: "Mine." });
    const res = await api().post(`/api/writings/${piece._id}/email`).set(bearer(other.token)).send({ to: "x@test.com" });
    expect(res.status).toBe(404);
    expect(fakeResend.sent).toHaveLength(0);
  });

  it("allows 5 copies a day", async () => {
    const student = await signUp();
    const piece = await saveWriting(student.token, { type: "sentence", content: "Hi." });
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await api().post(`/api/writings/${piece._id}/email`).set(bearer(student.token)).send({ to: "me@test.com" })).status);
    }
    expect(statuses).toEqual([204, 204, 204, 204, 204, 429]);
  });

  it("gives a friendly message when sending fails, and doesn't count it", async () => {
    const student = await signUp();
    const piece = await saveWriting(student.token, { type: "sentence", content: "Hi." });
    vi.spyOn(console, "error").mockImplementation(() => {});
    fakeResend.failNext = true;
    const res = await api().post(`/api/writings/${piece._id}/email`).set(bearer(student.token)).send({ to: "me@test.com" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/saved in My writing/);
    expect(await EmailLog.countDocuments({ userId: student.id, kind: "writing_copy" })).toBe(0);
  });
});
