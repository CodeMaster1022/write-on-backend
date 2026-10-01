import { Router } from "express";
import { env } from "../config/env.js";
import { runDailyJobs } from "../lib/notify.js";
import { HttpError } from "../middleware/error.js";

export const jobsRouter = Router();

/**
 * GET /api/jobs/daily — run by a scheduler (Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`;
 * any other scheduler can use `?key=`). Off entirely until CRON_SECRET is set.
 */
jobsRouter.get("/daily", async (req, res) => {
  if (!env.CRON_SECRET) throw new HttpError(404, "No route for GET /api/jobs/daily");
  const given = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? (typeof req.query.key === "string" ? req.query.key : "");
  if (given !== env.CRON_SECRET) throw new HttpError(401, "Not allowed.");

  const result = await runDailyJobs();
  console.log("[jobs] daily", JSON.stringify(result));
  res.json({ ok: true, ...result });
});
