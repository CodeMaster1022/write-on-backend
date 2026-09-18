import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";
import bcrypt from "bcryptjs";

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
    isGuest: { type: Boolean, default: false },

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
  },
  { timestamps: true },
);

userSchema.methods.verifyPassword = async function (candidate: string): Promise<boolean> {
  if (!this.passwordHash) return false;
  return bcrypt.compare(candidate, this.passwordHash as string);
};

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
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
    role: user.role,
    isGuest: user.isGuest,
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
