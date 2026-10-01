import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/error.js";

/**
 * The little of Stripe's API this app uses, called directly over HTTPS so the
 * test fake network can stand in for it. Card details never come here: paying
 * happens on Stripe's own Checkout page, and changes in Stripe's billing portal.
 */

export const PLAN_PRICES = { monthly: "$7 a month", yearly: "$59 a year" } as const;
export type Interval = keyof typeof PLAN_PRICES;

export function stripeEnabled(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_MONTHLY && env.STRIPE_PRICE_YEARLY);
}

const NOT_SET_UP = "Paying for Premium isn't set up yet. Everything stays free for now.";

/** Stripe takes form-encoded bodies with bracketed keys: line_items[0][price]=… */
function encode(params: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(params).flatMap(([key, value]) => {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) return [];
    if (typeof value === "object") return encode(value as Record<string, unknown>, name);
    return [`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`];
  });
}

async function stripe<T>(method: "GET" | "POST", path: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!stripeEnabled()) throw new HttpError(503, NOT_SET_UP);
  const body = method === "POST" ? encode(params).join("&") : "";
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: method === "POST" ? body : undefined,
    });
  } catch {
    throw new HttpError(502, "Couldn't reach the payment service right now. Please try again in a moment.");
  }
  if (!res.ok) {
    // Stripe's error text can name the account; keep it in the server log only.
    console.error("[stripe] request failed", res.status, path, await res.text().catch(() => ""));
    throw new HttpError(502, "The payment service answered with an error. Please try again in a moment.");
  }
  return (await res.json()) as T;
}

export async function createCustomer(email: string, familyId: string): Promise<string> {
  const customer = await stripe<{ id: string }>("POST", "customers", { email, metadata: { familyId } });
  return customer.id;
}

export async function createCheckoutSession(opts: {
  customerId: string;
  familyId: string;
  interval: Interval;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ id: string; url: string }> {
  return stripe("POST", "checkout/sessions", {
    mode: "subscription",
    customer: opts.customerId,
    client_reference_id: opts.familyId,
    line_items: { 0: { price: opts.interval === "monthly" ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_YEARLY, quantity: 1 } },
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    allow_promotion_codes: true,
    ...(env.STRIPE_AUTOMATIC_TAX ? { automatic_tax: { enabled: true }, customer_update: { address: "auto" } } : {}),
    subscription_data: { metadata: { familyId: opts.familyId } },
  });
}

export async function createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }> {
  return stripe("POST", "billing_portal/sessions", { customer: customerId, return_url: returnUrl });
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end?: boolean;
  /** Unix seconds. Newer API versions put it on each item; older ones on the subscription. */
  current_period_end?: number;
  items?: { data?: { current_period_end?: number }[] };
  metadata?: Record<string, string>;
}

export async function getSubscription(id: string): Promise<StripeSubscription> {
  return stripe("GET", `subscriptions/${encodeURIComponent(id)}`);
}

export function periodEndOf(sub: StripeSubscription): Date | null {
  const seconds = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return seconds ? new Date(seconds * 1000) : null;
}

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/**
 * Checks a webhook's Stripe-Signature header (t=…,v1=…) against the raw body,
 * the same way Stripe's own library does. Returns the parsed event, or throws.
 */
export function verifyWebhook(rawBody: Buffer | string, header: string | undefined, secret: string, now = Date.now()): { id: string; type: string; data: { object: Record<string, unknown> } } {
  if (!header) throw new HttpError(400, "Missing signature.");
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=") as [string, string]));
  const timestamp = Number(parts.t);
  const given = header
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  if (!Number.isFinite(timestamp) || given.length === 0) throw new HttpError(400, "Bad signature.");
  if (Math.abs(now / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) throw new HttpError(400, "Signature too old.");

  const payload = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  const ok = given.some((sig) => sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  if (!ok) throw new HttpError(400, "Bad signature.");

  try {
    return JSON.parse(payload);
  } catch {
    throw new HttpError(400, "Bad payload.");
  }
}

/** For tests and local tools: the header Stripe would send for this body. */
export function signWebhook(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}
