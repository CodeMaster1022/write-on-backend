import { Schema, model, type InferSchemaType } from "mongoose";

/** How long everything is free after a parent approves the account. */
export const TRIAL_DAYS = 14;
/** How long Premium keeps working after a payment fails, while Stripe retries the card. */
export const GRACE_DAYS = 7;

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"] as const;

/**
 * One family: the parent's email, and what they've paid for. Every student account
 * with that parent email shares it, so two children in one home are one plan.
 * The Stripe fields are filled in by webhooks; nothing here is ever edited from the browser.
 */
const familySchema = new Schema(
  {
    parentEmail: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 160 },
    /** The free trial that starts when a parent approves the first account. */
    trialEndsAt: { type: Date, required: true },

    stripeCustomerId: { type: String, default: null, index: true },
    stripeSubscriptionId: { type: String, default: null, index: true },
    subscriptionStatus: { type: String, enum: [...SUBSCRIPTION_STATUSES, null], default: null },
    /** When the paid period ends (Premium lasts to here after a cancellation). */
    currentPeriodEnd: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    /** Set when a payment fails: Premium stays on until this date while Stripe retries. */
    graceUntil: { type: Date, default: null },

    /** Erin can give a family Premium without paying: until this date (far in the future means "forever"). */
    compUntil: { type: Date, default: null },
    compNote: { type: String, default: "", maxlength: 120 },
  },
  { timestamps: true },
);

export type FamilyAttrs = InferSchemaType<typeof familySchema>;
export const Family = model("Family", familySchema);

export type PlanReason = "subscription" | "trial" | "grace" | "comp" | "admin";

export interface PlanInfo {
  plan: "premium" | "free";
  /** Why it's Premium, or null when it's Free. */
  reason: PlanReason | null;
  /** When the current Premium ends, if it's known to end. */
  until: Date | null;
  cancelAtPeriodEnd: boolean;
  /** True once the parent has paid at least once, so Stripe's billing portal has something to show. */
  hasBilling: boolean;
}

/** Works out the plan from a family record. Paid first, then comp, grace, then the trial. */
export function planOf(family: Pick<FamilyAttrs, "trialEndsAt" | "subscriptionStatus" | "currentPeriodEnd" | "cancelAtPeriodEnd" | "graceUntil" | "compUntil" | "stripeCustomerId"> | null, now = new Date()): PlanInfo {
  const hasBilling = Boolean(family?.stripeCustomerId);
  if (!family) return { plan: "free", reason: null, until: null, cancelAtPeriodEnd: false, hasBilling };

  const paid = family.subscriptionStatus === "active" || family.subscriptionStatus === "trialing";
  if (paid && (!family.currentPeriodEnd || family.currentPeriodEnd > now)) {
    return { plan: "premium", reason: "subscription", until: family.currentPeriodEnd ?? null, cancelAtPeriodEnd: family.cancelAtPeriodEnd ?? false, hasBilling };
  }
  if (family.compUntil && family.compUntil > now) {
    return { plan: "premium", reason: "comp", until: family.compUntil, cancelAtPeriodEnd: false, hasBilling };
  }
  if (family.subscriptionStatus === "past_due" && family.graceUntil && family.graceUntil > now) {
    return { plan: "premium", reason: "grace", until: family.graceUntil, cancelAtPeriodEnd: false, hasBilling };
  }
  if (family.trialEndsAt > now && !family.subscriptionStatus) {
    return { plan: "premium", reason: "trial", until: family.trialEndsAt, cancelAtPeriodEnd: false, hasBilling };
  }
  return { plan: "free", reason: null, until: null, cancelAtPeriodEnd: false, hasBilling };
}
