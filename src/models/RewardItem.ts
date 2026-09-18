import { Schema, model, type InferSchemaType } from "mongoose";
import { EQUIP_SLOTS } from "./User.js";

const rewardItemSchema = new Schema(
  {
    /** Stable string id used in User.ownedItems and User.equipped. */
    key: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    slot: { type: String, enum: EQUIP_SLOTS, required: true, index: true },
    cost: { type: Number, required: true, min: 0 },

    /** Names the SVG variant the client draws — no image files to serve. */
    art: { type: String, required: true, trim: true, maxlength: 40 },
    /** Primary colour the client uses when drawing the item. */
    color: { type: String, default: "#FF7A5C", trim: true, maxlength: 20 },

    blurb: { type: String, trim: true, maxlength: 160, default: "" },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export type RewardItemAttrs = InferSchemaType<typeof rewardItemSchema>;
export const RewardItem = model("RewardItem", rewardItemSchema);
