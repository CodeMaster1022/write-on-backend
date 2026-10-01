import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { env } from "../config/env.js";
import { appUrl, sendEmail } from "../lib/email.js";
import { paymentFailedEmail, upgradeLinkEmail } from "../lib/emails.js";
import { FREE_WEEKLY, ensureFamily, freeLeft, planFor } from "../lib/plan.js";
import {
  PLAN_PRICES,
  createCheckoutSession,
  createCustomer,
  createPortalSession,
  getSubscription,
  periodEndOf,
  stripeEnabled,
  verifyWebhook,
  type StripeSubscription,
} from "../lib/stripe.js";
import { timeZoneOf } from "../lib/time.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { Family, GRACE_DAYS, SUBSCRIPTION_STATUSES, planOf } from "../models/Family.js";
import { BillingLink, EmailLog } from "../models/PasswordReset.js";
import { User } from "../models/User.js";

export const billingRouter = Router();
/** Mounted separately, before the JSON parser, because Stripe's signature covers the raw bytes. */
export const stripeWebhookRouter = Router();

const DAY = 24 * 60 * 60 * 1000;
const LINK_DAYS = 7;
const LINKS_PER_DAY = 3;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const planJson = (p: ReturnType<typeof planOf>) => ({ ...p, prices: PLAN_PRICES, stripeEnabled: stripeEnabled(), freeWeekly: FREE_WEEKLY });

// ---------------------------------------------------------------------------
// Signed-in: what's my plan, ask a parent, manage billing
// ---------------------------------------------------------------------------

billingRouter.get("/plan", requireAuth, async (req, res) => {
  const plan = await planFor(req.user!);
  const left = plan.plan === "premium" ? null : await freeLeft(req.user!, timeZoneOf(req));
  res.json({ ...planJson(plan), freeLeft: left });
});

async function newBillingLink(familyId: unknown): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await BillingLink.create({ familyId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + LINK_DAYS * DAY) });
  return `${appUrl()}/upgrade?token=${token}`;
}

/** "Ask a parent": emails the parent a link to the upgrade page. The child never sees a price or a card form. */
billingRouter.post("/parent-link", requireAuth, async (req, res) => {
  const user = req.user!;
  if (!stripeEnabled()) throw new HttpError(503, "Paying for Premium isn't set up yet. Everything stays free for now.");
  if (!user.parentEmail || !user.parentApprovedAt) throw new HttpError(400, "A parent needs to approve the account first.");

  const family = await ensureFamily(user.parentEmail);
  const sentToday = await EmailLog.countDocuments({ userId: user._id, kind: "upgrade_link", createdAt: { $gte: new Date(Date.now() - DAY) } });
  if (sentToday >= LINKS_PER_DAY) throw new HttpError(429, "We've emailed your parent about Premium 3 times today. Ask them to check their inbox.");

  const link = await newBillingLink(family._id);
  await sendEmail({
    to: user.parentEmail,
    ...upgradeLinkEmail({ name: user.displayName }, PLAN_PRICES, link),
    failMessage: "Couldn't send the email right now. Please try again in a few minutes.",
  });
  await EmailLog.create({ userId: user._id, kind: "upgrade_link", toHash: sha256(user.parentEmail) });
  res.json({ ok: true, sentTo: user.parentEmail });
});

/** Stripe's billing portal (change card, cancel, invoices), for a parent sitting with the student. */
billingRouter.post("/portal", requireAuth, async (req, res) => {
  const user = req.user!;
  const family = user.parentEmail ? await Family.findOne({ parentEmail: user.parentEmail }).lean() : null;
  if (!family?.stripeCustomerId) throw new HttpError(400, "There's no paid plan on this family yet.");
  const session = await createPortalSession(family.stripeCustomerId, `${appUrl()}/app/account`);
  res.json({ url: session.url });
});

// ---------------------------------------------------------------------------
// The parent's link: no sign-in, only the token from the email
// ---------------------------------------------------------------------------

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "This link isn't valid. Ask the student to send a new one from the app.");
const LINK_GONE = "This link has expired. The student can send a new one from the app.";

const parentLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new HttpError(429, "Too many tries. Please wait a few minutes and try again.")),
});

async function familyFromToken(raw: unknown) {
  const token = tokenSchema.parse(raw);
  const link = await BillingLink.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } }).lean();
  const family = link ? await Family.findById(link.familyId) : null;
  if (!family) throw new HttpError(400, LINK_GONE);
  return { token, family };
}

/** What the parent sees on the upgrade page: the plan today, prices, and the children covered. */
billingRouter.get("/parent", parentLimiter, async (req, res) => {
  const { family } = await familyFromToken(req.query.token);
  const students = await User.find({ parentEmail: family.parentEmail, parentApprovedAt: { $ne: null } }).select("displayName").lean();
  res.json({ ...planJson(planOf(family)), parentEmail: family.parentEmail, students: students.map((s) => s.displayName) });
});

const checkoutSchema = z.object({ token: tokenSchema, interval: z.enum(["monthly", "yearly"]) });

/** Starts Stripe Checkout and returns its page address. */
billingRouter.post("/checkout", parentLimiter, async (req, res) => {
  const { token, interval } = checkoutSchema.parse(req.body);
  const { family } = await familyFromToken(token);
  const current = planOf(family);
  if (current.reason === "subscription") throw new HttpError(400, "This family already has Premium. Use Manage billing to change it.");

  if (!family.stripeCustomerId) {
    family.stripeCustomerId = await createCustomer(family.parentEmail, family.id as string);
    await family.save();
  }
  const session = await createCheckoutSession({
    customerId: family.stripeCustomerId,
    familyId: family.id as string,
    interval,
    successUrl: `${appUrl()}/upgrade?token=${token}&done=1`,
    cancelUrl: `${appUrl()}/upgrade?token=${token}`,
  });
  res.json({ url: session.url });
});

/** Stripe's portal from the parent's link, for parents who don't share the child's screen. */
billingRouter.post("/parent-portal", parentLimiter, async (req, res) => {
  const { token, family } = await familyFromToken((req.body as { token?: unknown })?.token);
  if (!family.stripeCustomerId) throw new HttpError(400, "There's no paid plan on this family yet.");
  const session = await createPortalSession(family.stripeCustomerId, `${appUrl()}/upgrade?token=${token}`);
  res.json({ url: session.url });
});

// ---------------------------------------------------------------------------
// Webhook: Stripe tells us what happened
// ---------------------------------------------------------------------------

async function applySubscription(sub: StripeSubscription) {
  const status = (SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status) ? (sub.status as (typeof SUBSCRIPTION_STATUSES)[number]) : null;
  const family =
    (await Family.findOne({ stripeSubscriptionId: sub.id })) ??
    (await Family.findOne({ stripeCustomerId: sub.customer })) ??
    (sub.metadata?.familyId ? await Family.findById(sub.metadata.familyId) : null);
  if (!family) {
    console.error(`[stripe] subscription ${sub.id} doesn't match any family`);
    return;
  }
  family.stripeCustomerId = family.stripeCustomerId ?? sub.customer;
  family.stripeSubscriptionId = sub.id;
  family.subscriptionStatus = status;
  family.currentPeriodEnd = periodEndOf(sub);
  family.cancelAtPeriodEnd = sub.cancel_at_period_end ?? false;
  if (status === "active") family.graceUntil = null;
  await family.save();
}

stripeWebhookRouter.post("/", async (req, res) => {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(404, "No route for POST /api/billing/webhook");
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
  const event = verifyWebhook(raw, req.header("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  const object = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      const familyId = (object.client_reference_id as string | null) ?? null;
      const customer = object.customer as string | null;
      const subscriptionId = object.subscription as string | null;
      const family = familyId ? await Family.findById(familyId) : customer ? await Family.findOne({ stripeCustomerId: customer }) : null;
      if (family && customer) {
        family.stripeCustomerId = customer;
        if (subscriptionId) family.stripeSubscriptionId = subscriptionId;
        await family.save();
        // The subscription's own events may already have arrived or still be on their way; read it once to be sure.
        if (subscriptionId) await applySubscription(await getSubscription(subscriptionId));
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await applySubscription(object as unknown as StripeSubscription);
      break;
    case "invoice.payment_failed": {
      const customer = object.customer as string | null;
      const family = customer ? await Family.findOne({ stripeCustomerId: customer }) : null;
      if (family) {
        if (!family.graceUntil || family.graceUntil < new Date()) family.graceUntil = new Date(Date.now() + GRACE_DAYS * DAY);
        if (family.subscriptionStatus === "active") family.subscriptionStatus = "past_due";
        await family.save();
        const recently = await EmailLog.exists({ kind: "payment_failed", toHash: sha256(family.parentEmail), createdAt: { $gte: new Date(Date.now() - DAY) } });
        if (!recently) {
          try {
            await sendEmail({ to: family.parentEmail, ...paymentFailedEmail(await newBillingLink(family._id), GRACE_DAYS) });
            await EmailLog.create({ kind: "payment_failed", toHash: sha256(family.parentEmail) });
          } catch (err) {
            console.error("[stripe] couldn't send the payment-failed email", err instanceof Error ? err.message : err);
          }
        }
      }
      break;
    }
    default:
      break;
  }
  res.json({ received: true });
});
