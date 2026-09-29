import { Router } from "express";
import { z } from "zod";
import { GOAL_CHOICES, buildProgress } from "../lib/progress.js";
import { timeZoneOf, weekStartKey } from "../lib/time.js";
import { requireAuth } from "../middleware/auth.js";

export const progressRouter = Router();

progressRouter.use(requireAuth);

/** Skills over time, the weekly goal and streak, and badges, for the student's own My progress page. */
progressRouter.get("/me", async (req, res) => {
  res.json(await buildProgress(req.user!, timeZoneOf(req)));
});

const goalSchema = z.object({
  perWeek: z
    .number()
    .int()
    .refine((n) => (GOAL_CHOICES as readonly number[]).includes(n), `Pick ${GOAL_CHOICES.join(", ")} pieces a week.`)
    .nullable(),
});

/** Sets (or turns off, with null) the weekly goal, starting with the current week. */
progressRouter.put("/goal", async (req, res) => {
  const { perWeek } = goalSchema.parse(req.body);
  const user = req.user!;
  const week = weekStartKey(new Date(), timeZoneOf(req));

  // One entry per week: changing the goal twice in a week keeps only the latest choice.
  const history = (user.goalHistory ?? [])
    .filter((h) => h.weekStart !== week)
    .map((h) => ({ weekStart: h.weekStart, perWeek: h.perWeek ?? null }));
  history.push({ weekStart: week, perWeek });
  user.set({ weeklyGoal: perWeek, goalHistory: history });
  await user.save();

  res.json(await buildProgress(user, timeZoneOf(req)));
});
