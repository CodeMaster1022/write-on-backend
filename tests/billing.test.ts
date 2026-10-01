import { beforeAll, describe, expect, it } from "vitest";
import { signWebhook } from "../src/lib/stripe.js";
import { Family } from "../src/models/Family.js";
import { fakeOpenAi, fakeResend, fakeStripe } from "./fake-network.js";
import { api, bearer, feedbackReply, saveWriting, seedBasics, signUp, signUpAdmin, type TestUser } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;
let admin: TestUser;

beforeAll(async () => {
  await seedBasics();
  admin = await signUpAdmin();
});

const plan = (token: string) => api().get("/api/billing/plan").set(bearer(token));
const analyze = (token: string) => {
  fakeOpenAi.chatReplies.push(feedbackReply());
  return api().post("/api/ai/analyze").set(bearer(token)).send({ type: "paragraph", content: "Dogs are great because they play." });
};
const askInki = (token: string) => api().post("/api/inki/define").set(bearer(token)).send({ term: "octopus" });

/** A student whose family's trial is over, so they're on the free plan. */
async function freeStudent(overrides: Parameters<typeof signUp>[0] = {}) {
  const student = await signUp(overrides);
  await plan(student.token); // creates the family
  await Family.updateOne({ parentEmail: student.parentEmail }, { trialEndsAt: new Date(Date.now() - DAY) });
  return student;
}

const upgradeToken = (parentEmail: string) =>
  fakeResend.sent
    .filter((m) => m.to.includes(parentEmail) && m.subject.endsWith("would like Write on! Premium"))
    .at(-1)!
    .text.match(/https:\/\/write-on\.test\/upgrade\?token=([A-Za-z0-9_-]+)/)![1]!;

function webhook(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: `evt_${Date.now()}`, type, data: { object } });
  return api()
    .post("/api/billing/webhook")
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", signWebhook(payload, "whsec_test_fake"))
    .send(payload);
}

describe("the plan", () => {
  it("starts as a 14-day Premium trial when a parent approves, then drops to Free", async () => {
    const student = await signUp();
    const trial = await plan(student.token);
    expect(trial.body).toMatchObject({ plan: "premium", reason: "trial", stripeEnabled: true, prices: { monthly: "$7 a month", yearly: "$59 a year" } });
    const until = new Date(trial.body.until).getTime();
    expect(until).toBeGreaterThan(Date.now() + 13 * DAY);
    expect(until).toBeLessThan(Date.now() + 15 * DAY);

    await Family.updateOne({ parentEmail: student.parentEmail }, { trialEndsAt: new Date(Date.now() - 1000) });
    const free = await plan(student.token);
    expect(free.body).toMatchObject({ plan: "free", reason: null, freeLeft: { aiChecks: 3, inkiQuestions: 3 } });
  });

  it("is shared by every child with the same parent email", async () => {
    const first = await freeStudent();
    const sibling = await signUp();
    await api().patch("/api/auth/me").set(bearer(sibling.token)).send({ parentEmail: first.parentEmail }).catch(() => {});
    // The sibling was approved with a different parent address at sign-up; move them under the same family directly.
    const { User } = await import("../src/models/User.js");
    await User.updateOne({ _id: sibling.id }, { parentEmail: first.parentEmail });
    expect((await plan(sibling.token)).body.plan).toBe("free");

    await Family.updateOne({ parentEmail: first.parentEmail }, { compUntil: new Date(Date.now() + 30 * DAY) });
    expect((await plan(sibling.token)).body).toMatchObject({ plan: "premium", reason: "comp" });
    expect((await plan(first.token)).body.plan).toBe("premium");
  });

  it("is always Premium for admins", async () => {
    expect((await plan(admin.token)).body).toMatchObject({ plan: "premium", reason: "admin" });
  });
});

describe("the free plan", () => {
  it("allows 3 AI checks a week, then asks for Premium", async () => {
    const student = await freeStudent();
    for (let i = 3; i >= 1; i--) {
      const res = await analyze(student.token);
      expect(res.status).toBe(200);
      expect(res.body.freeLeft).toBe(i - 1);
    }
    const fourth = await analyze(student.token);
    expect(fourth.status).toBe(402);
    expect(fourth.body).toMatchObject({ error: expect.stringContaining("ask a parent"), details: { code: "premium_needed", feature: "ai_feedback", freeLeft: 0 } });
  });

  it("allows 3 questions to Inki a week, and the status says so", async () => {
    const student = await freeStudent({ gradeLevel: "8" });
    const status = await api().get("/api/inki/status").set(bearer(student.token));
    expect(status.body).toMatchObject({ plan: "free", limit: 20, remaining: 3, freeLeft: 3 });
    for (let i = 0; i < 3; i++) expect((await askInki(student.token)).status).toBe(200);
    const fourth = await askInki(student.token);
    expect(fourth.status).toBe(402);
    expect(fourth.body.details).toMatchObject({ code: "premium_needed", feature: "inki" });
  });

  it("has no voice typing, and a report with numbers but no summary, Word file, email or link", async () => {
    const student = await freeStudent();
    await saveWriting(student.token, { type: "paragraph", content: "Some writing to report on.", activeSeconds: 60 });

    const stt = await api().post("/api/stt/token").set(bearer(student.token));
    expect(stt.status).toBe(402);
    expect(stt.body.details.feature).toBe("voice_typing");

    const report = await api().get("/api/report/me?days=30").set(bearer(student.token));
    expect(report.status).toBe(200);
    expect(report.body.premium).toBe(false);
    expect(report.body.report.activity.totalPieces).toBe(1);
    expect(report.body.report.summary ?? null).toBeNull();
    expect(fakeOpenAi.chatCalls()).toHaveLength(0);

    for (const req of [
      api().get("/api/report/me.docx").set(bearer(student.token)),
      api().post("/api/report/email").set(bearer(student.token)).send({ to: "p@test.com", days: 30 }),
      api().post("/api/report/shares").set(bearer(student.token)).send({ days: 30 }),
    ]) {
      const res = await req;
      expect(res.status).toBe(402);
      expect(res.body.details.feature).toBe("report");
    }
  });

  it("keeps everything else working: writing, lessons, contests, read-aloud", async () => {
    const student = await freeStudent();
    expect((await api().post("/api/writings").set(bearer(student.token)).send({ type: "sentence", content: "Free to write." })).status).toBe(201);
    expect((await api().get("/api/lessons").set(bearer(student.token))).status).toBe(200);
    expect((await api().get("/api/contests").set(bearer(student.token))).status).toBe(200);
    expect((await api().get("/api/progress/me").set(bearer(student.token))).status).toBe(200);
  });
});

describe("asking a parent", () => {
  it("emails the parent a link to the upgrade page, never the child a price", async () => {
    const student = await freeStudent({ displayName: "Lia" });
    const res = await api().post("/api/billing/parent-link").set(bearer(student.token));
    expect(res.status).toBe(200);
    expect(res.body.sentTo).toBe(student.parentEmail);

    const mail = fakeResend.sent.at(-1)!;
    expect(mail.to).toEqual([student.parentEmail]);
    expect(mail.subject).toBe("Lia would like Write on! Premium");
    expect(mail.text).toContain("$7 a month or $59 a year");
    const token = upgradeToken(student.parentEmail);
    expect(token).toBeTruthy();

    const page = await api().get(`/api/billing/parent?token=${token}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ plan: "free", parentEmail: student.parentEmail, students: ["Lia"] });

    expect((await api().get("/api/billing/parent?token=" + "x".repeat(43))).status).toBe(400);
  });

  it("sends at most 3 links a day", async () => {
    const student = await freeStudent();
    for (let i = 0; i < 3; i++) expect((await api().post("/api/billing/parent-link").set(bearer(student.token))).status).toBe(200);
    expect((await api().post("/api/billing/parent-link").set(bearer(student.token))).status).toBe(429);
  });
});

describe("paying through Stripe", () => {
  it("starts Checkout for the right price with the family as the customer, and the webhook turns Premium on", async () => {
    const student = await freeStudent({ displayName: "Pay" });
    await api().post("/api/billing/parent-link").set(bearer(student.token));
    const token = upgradeToken(student.parentEmail);

    const checkout = await api().post("/api/billing/checkout").send({ token, interval: "yearly" });
    expect(checkout.status).toBe(200);
    expect(checkout.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);

    const customer = fakeStripe.calls.find((c) => c.path === "customers")!;
    expect(customer.params.email).toBe(student.parentEmail);
    const session = fakeStripe.calls.find((c) => c.path === "checkout/sessions")!;
    expect(session.params).toMatchObject({
      mode: "subscription",
      customer: customer.params ? expect.stringMatching(/^cus_test/) : "",
      "line_items[0][price]": "price_yearly_test",
      success_url: `https://write-on.test/upgrade?token=${token}&done=1`,
      cancel_url: `https://write-on.test/upgrade?token=${token}`,
    });
    const family = (await Family.findOne({ parentEmail: student.parentEmail }).lean())!;
    expect(family.stripeCustomerId).toMatch(/^cus_test/);
    expect(session.params.client_reference_id).toBe(String(family._id));

    // Stripe says the payment went through.
    const periodEnd = Math.floor((Date.now() + 365 * DAY) / 1000);
    fakeStripe.subscriptions.set("sub_test1", { id: "sub_test1", customer: family.stripeCustomerId, status: "active", current_period_end: periodEnd, cancel_at_period_end: false });
    const hook = await webhook("checkout.session.completed", { client_reference_id: String(family._id), customer: family.stripeCustomerId, subscription: "sub_test1" });
    expect(hook.status).toBe(200);

    const now = await plan(student.token);
    expect(now.body).toMatchObject({ plan: "premium", reason: "subscription", hasBilling: true, cancelAtPeriodEnd: false });
    expect(new Date(now.body.until).getTime()).toBe(periodEnd * 1000);

    // Premium: no weekly cap on AI checks.
    for (let i = 0; i < 4; i++) expect((await analyze(student.token)).status).toBe(200);

    // The portal opens for the family, from the app and from the parent's link.
    const portal = await api().post("/api/billing/portal").set(bearer(student.token));
    expect(portal.body.url).toMatch(/^https:\/\/billing\.stripe\.test\//);
    expect((await api().post("/api/billing/parent-portal").send({ token })).status).toBe(200);
    // And Checkout refuses a second subscription.
    expect((await api().post("/api/billing/checkout").send({ token, interval: "monthly" })).status).toBe(400);
  });

  it("follows cancellations and failed payments: grace for a week, then Free; nothing deleted", async () => {
    const student = await freeStudent();
    await plan(student.token);
    await Family.updateOne({ parentEmail: student.parentEmail }, { stripeCustomerId: "cus_fam", stripeSubscriptionId: "sub_fam", subscriptionStatus: "active", currentPeriodEnd: new Date(Date.now() + 20 * DAY) });
    expect((await plan(student.token)).body.plan).toBe("premium");

    // Cancel at period end: still Premium until then, and the plan says so.
    await webhook("customer.subscription.updated", { id: "sub_fam", customer: "cus_fam", status: "active", cancel_at_period_end: true, current_period_end: Math.floor((Date.now() + 20 * DAY) / 1000) });
    expect((await plan(student.token)).body).toMatchObject({ plan: "premium", cancelAtPeriodEnd: true });

    // A failed payment: a week of grace and one email to the parent.
    fakeResend.sent = [];
    await webhook("customer.subscription.updated", { id: "sub_fam", customer: "cus_fam", status: "past_due", current_period_end: Math.floor((Date.now() - DAY) / 1000) });
    await webhook("invoice.payment_failed", { customer: "cus_fam" });
    const grace = await plan(student.token);
    expect(grace.body).toMatchObject({ plan: "premium", reason: "grace" });
    expect(new Date(grace.body.until).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    const mail = fakeResend.sent.find((m) => m.subject.includes("couldn't take the payment"))!;
    expect(mail.to).toEqual([student.parentEmail]);
    expect(mail.text).toContain("https://write-on.test/upgrade?token=");
    await webhook("invoice.payment_failed", { customer: "cus_fam" });
    expect(fakeResend.sent.filter((m) => m.subject.includes("couldn't take the payment"))).toHaveLength(1);

    // Stripe gives up: Free, writing kept.
    await webhook("customer.subscription.deleted", { id: "sub_fam", customer: "cus_fam", status: "canceled" });
    await Family.updateOne({ parentEmail: student.parentEmail }, { graceUntil: new Date(Date.now() - 1000) });
    expect((await plan(student.token)).body.plan).toBe("free");
    expect((await api().get("/api/writings").set(bearer(student.token))).status).toBe(200);
  });

  it("refuses webhooks that aren't signed by Stripe", async () => {
    const payload = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "sub_x", customer: "cus_x", status: "canceled" } } });
    expect((await api().post("/api/billing/webhook").set("Content-Type", "application/json").send(payload)).status).toBe(400);
    const wrong = await api()
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", signWebhook(payload, "whsec_wrong"))
      .send(payload);
    expect(wrong.status).toBe(400);
    const old = await api()
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", signWebhook(payload, "whsec_test_fake", Math.floor(Date.now() / 1000) - 3600))
      .send(payload);
    expect(old.status).toBe(400);
  });

  it("says so kindly when Stripe is down", async () => {
    const student = await freeStudent();
    await api().post("/api/billing/parent-link").set(bearer(student.token));
    fakeStripe.down = true;
    const res = await api().post("/api/billing/checkout").send({ token: upgradeToken(student.parentEmail), interval: "monthly" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("payment service");
  });
});

describe("in the admin area", () => {
  it("shows each student's plan and lets Erin give a family free Premium", async () => {
    const student = await freeStudent({ displayName: "Comp Kid" });
    const before = await api().get(`/api/admin/users?q=${encodeURIComponent(student.email)}`).set(bearer(admin.token));
    expect(before.body.users[0]).toMatchObject({ plan: "free" });

    const comp = await api().post(`/api/admin/users/${student.id}/comp`).set(bearer(admin.token)).send({ months: 3, note: "Tutor family" });
    expect(comp.status).toBe(200);
    expect(comp.body.plan).toMatchObject({ plan: "premium", reason: "comp" });
    expect((await plan(student.token)).body.reason).toBe("comp");

    const detail = await api().get(`/api/admin/users/${student.id}`).set(bearer(admin.token));
    expect(detail.body.user.plan).toMatchObject({ plan: "premium", reason: "comp", compNote: "Tutor family" });

    const forever = await api().post(`/api/admin/users/${student.id}/comp`).set(bearer(admin.token)).send({ months: "forever" });
    expect(new Date(forever.body.plan.until).getFullYear()).toBeGreaterThan(2900);
    const none = await api().post(`/api/admin/users/${student.id}/comp`).set(bearer(admin.token)).send({ months: "none" });
    expect(none.body.plan.plan).toBe("free");

    const activity = await api().get("/api/admin/activity").set(bearer(admin.token));
    expect(activity.body.actions.filter((a: { kind: string }) => a.kind === "user_comp").length).toBeGreaterThanOrEqual(3);
  });
});
