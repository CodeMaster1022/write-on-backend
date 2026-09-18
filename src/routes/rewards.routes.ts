import { Router } from "express";
import { z } from "zod";
import { RewardItem } from "../models/RewardItem.js";
import { EQUIP_SLOTS, publicUser } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";

export const rewardsRouter = Router();

rewardsRouter.use(requireAuth);

/** Everything the Club Inki Closet screen needs in one call. */
rewardsRouter.get("/", async (req, res) => {
  const user = req.user!;
  const items = await RewardItem.find().sort({ slot: 1, sortOrder: 1, cost: 1 }).lean();

  res.json({
    items: items.map((item) => ({
      ...item,
      owned: user.ownedItems.includes(item.key),
      affordable: user.inkDrops >= item.cost,
    })),
    inkDrops: user.inkDrops,
    equipped: publicUser(user).equipped,
  });
});

const unlockSchema = z.object({ key: z.string().trim().min(1) });

rewardsRouter.post("/unlock", async (req, res) => {
  const { key } = unlockSchema.parse(req.body);
  const user = req.user!;

  const item = await RewardItem.findOne({ key });
  if (!item) throw new HttpError(404, "That item isn't in the closet.");

  if (user.ownedItems.includes(key)) throw new HttpError(409, "Inki already owns that!");
  if (user.inkDrops < item.cost) {
    throw new HttpError(402, `Keep writing! That costs ${item.cost} ink drops and you have ${user.inkDrops}.`);
  }

  user.inkDrops -= item.cost;
  user.ownedItems.push(key);
  // Wearing it right away is the payoff — that's the whole point of the reward.
  user.equipped![item.slot] = key;

  await user.save();

  res.json({ item: { ...item.toObject(), owned: true }, user: publicUser(user) });
});

const equipSchema = z.object({
  slot: z.enum(EQUIP_SLOTS),
  key: z.string().trim().min(1).nullable(),
});

rewardsRouter.post("/equip", async (req, res) => {
  const { slot, key } = equipSchema.parse(req.body);
  const user = req.user!;

  if (key !== null) {
    if (!user.ownedItems.includes(key)) throw new HttpError(403, "Unlock that item first.");

    const item = await RewardItem.findOne({ key });
    if (!item) throw new HttpError(404, "That item isn't in the closet.");
    if (item.slot !== slot) throw new HttpError(400, `${item.name} doesn't go in the ${slot} slot.`);
  }

  user.equipped![slot] = key;
  await user.save();

  res.json({ user: publicUser(user) });
});
