import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";

export const EQUIP_SLOTS = ["hat", "neck", "held", "scene"] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];

const userSchema = new Schema(
  {
    displayName: { type: String, required: true, trim: true, maxlength: 60 },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      sparse: true,
      unique: true,
      maxlength: 160,
    },
    passwordHash: { type: String, select: false },
    role: { type: String, enum: ["student", "teacher"], default: "student", index: true },
    /** Only on accounts made before guests stopped having accounts. They're signed out and cleaned up with `npm run remove-guests`. */
    isGuest: { type: Boolean, default: false },
    /** Can run contests. Only set with `npm run make-admin`, never through the API. */
    isAdmin: { type: Boolean, default: false },

    gradeLevel: { type: String, trim: true, maxlength: 20 },

    // Teachers own a class code; students join with it.
    classCode: { type: String, uppercase: true, trim: true, index: true, maxlength: 12 },

    inkDrops: { type: Number, default: 0, min: 0 },
    ownedItems: { type: [String], default: [] },
    equipped: {
      hat: { type: String, default: null },
      neck: { type: String, default: null },
      held: { type: String, default: null },
      scene: { type: String, default: null },
    },

    writingCount: { type: Number, default: 0, min: 0 },
    lastWroteAt: { type: Date, default: null },

    /**
     * Whether the account's email is confirmed. Defaults to true so accounts made
     * before verification existed count as confirmed; sign-up sets it to false.
     */
    emailVerified: { type: Boolean, default: true },

    /** When the password was last reset. */
    passwordChangedAt: { type: Date, default: null },
    /** Every session carries this number. Raising it (on a password reset) signs out every device at once. */
    sessionVersion: { type: Number, default: 0 },

    /** Pieces the student wants to finish each week, or null for no goal. */
    weeklyGoal: { type: Number, min: 1, max: 14, default: null },
    /**
     * The goal in force from each week on ("YYYY-MM-DD" of the Monday). A week
     * is judged by the goal set for it, so lowering the goal later can't build
     * a streak backwards.
     */
    goalHistory: {
      type: [{ _id: false, weekStart: { type: String, required: true }, perWeek: { type: Number, default: null } }],
      default: [],
    },
  },
  { timestamps: true },
);

userSchema.methods.verifyPassword = async function (candidate: string): Promise<boolean> {
  if (!this.passwordHash) return false;
  return bcrypt.compare(candidate, this.passwordHash as string);
};

// Full strength everywhere except automated tests, where hundreds of sign-ups would otherwise take minutes.
const HASH_ROUNDS = env.NODE_ENV === "test" ? 4 : 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, HASH_ROUNDS);
}

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserAttrs, { verifyPassword(candidate: string): Promise<boolean> }>;

export const User = model<UserAttrs, import("mongoose").Model<UserAttrs, {}, { verifyPassword(candidate: string): Promise<boolean> }>>(
  "User",
  userSchema,
);

/** Shape sent to the client — never includes passwordHash. */
export function publicUser(user: UserDoc) {
  return {
    id: user.id as string,
    displayName: user.displayName,
    email: user.email ?? null,
    emailVerified: user.emailVerified ?? true,
    role: user.role,
    isAdmin: user.isAdmin ?? false,
    gradeLevel: user.gradeLevel ?? null,
    classCode: user.classCode ?? null,
    inkDrops: user.inkDrops,
    ownedItems: user.ownedItems,
    equipped: {
      hat: user.equipped?.hat ?? null,
      neck: user.equipped?.neck ?? null,
      held: user.equipped?.held ?? null,
      scene: user.equipped?.scene ?? null,
    },
    writingCount: user.writingCount,
    lastWroteAt: user.lastWroteAt ?? null,
  };
}
