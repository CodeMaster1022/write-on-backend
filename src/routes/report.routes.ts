import { createHash, randomBytes } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { sendEmail } from "../lib/email.js";
import { REPORT_PERIODS, buildReport, withSummary, type Report } from "../lib/report.js";
import { reportDocument, reportDocx, reportEmail } from "../lib/report-export.js";
import { startOfToday, timeZoneOf } from "../lib/time.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { ReportEmail, ReportShare } from "../models/ReportShare.js";
import { User } from "../models/User.js";

export const reportRouter = Router();

const SHARE_DAYS = 30;
const MAX_ACTIVE_SHARES = 10;
const EMAILS_PER_DAY = 5;
const EXPIRED_LINK = "This report link has expired or was turned off. Ask for a new one.";

const periodSchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((n) => (REPORT_PERIODS as readonly number[]).includes(n), "Pick 7, 30, or 90 days.")
    .default(30),
});

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function sendDocx(res: Response, buffer: Buffer, report: Report) {
  const date = report.generatedAt.slice(0, 10);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="write-on-progress-report-${date}.docx"`);
  res.send(buffer);
}

// ---------------------------------------------------------------------------
// The student's own report
// ---------------------------------------------------------------------------

reportRouter.get("/me", requireAuth, async (req, res) => {
  const { days } = periodSchema.parse(req.query);
  const tz = timeZoneOf(req);
  const report = await withSummary(req.user!, await buildReport(req.user!, days, tz));
  res.json({ report, document: reportDocument(report, tz) });
});

reportRouter.get("/me.docx", requireAuth, async (req, res) => {
  const { days } = periodSchema.parse(req.query);
  const tz = timeZoneOf(req);
  const report = await withSummary(req.user!, await buildReport(req.user!, days, tz));
  sendDocx(res, await reportDocx(report, tz), report);
});

const emailSchema = periodSchema.extend({
  to: z.string().trim().toLowerCase().email("That email doesn't look right.").max(160),
});

reportRouter.post("/email", requireAuth, async (req, res) => {
  const { to, days } = emailSchema.parse(req.body);
  const tz = timeZoneOf(req);

  const sentToday = await ReportEmail.countDocuments({ userId: req.user!._id, createdAt: { $gte: startOfToday(tz) } });
  if (sentToday >= EMAILS_PER_DAY) {
    throw new HttpError(429, `You can email up to ${EMAILS_PER_DAY} reports a day. Try again tomorrow, or download it instead.`);
  }

  const report = await withSummary(req.user!, await buildReport(req.user!, days, tz));
  const docx = await reportDocx(report, tz);
  const email = reportEmail(report, tz);

  await sendEmail({
    to,
    ...email,
    attachments: [{ filename: `write-on-progress-report-${report.generatedAt.slice(0, 10)}.docx`, content: docx }],
  });
  await ReportEmail.create({ userId: req.user!._id });

  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

function activeShareFilter(userId: unknown) {
  return { userId, revokedAt: null, expiresAt: { $gt: new Date() } };
}

reportRouter.get("/shares", requireAuth, async (req, res) => {
  const shares = await ReportShare.find(activeShareFilter(req.user!._id)).sort({ createdAt: -1 }).lean();
  res.json({
    shares: shares.map((s) => ({
      id: String(s._id),
      periodDays: s.periodDays,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    })),
  });
});

reportRouter.post("/shares", requireAuth, async (req, res) => {
  const { days } = periodSchema.parse(req.body ?? {});

  const active = await ReportShare.countDocuments(activeShareFilter(req.user!._id));
  if (active >= MAX_ACTIVE_SHARES) {
    throw new HttpError(400, `You already have ${MAX_ACTIVE_SHARES} active links. Turn one off first.`);
  }

  // The raw token is only ever returned here; the database keeps its hash.
  const token = randomBytes(24).toString("base64url");
  const share = await ReportShare.create({
    userId: req.user!._id,
    tokenHash: hashToken(token),
    periodDays: days,
    timeZone: timeZoneOf(req),
    expiresAt: new Date(Date.now() + SHARE_DAYS * 24 * 60 * 60 * 1000),
  });

  res.status(201).json({ id: share.id as string, token, periodDays: days, expiresAt: share.expiresAt });
});

reportRouter.delete("/shares/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  if (!/^[a-f0-9]{24}$/.test(id)) throw new HttpError(404, "That link was already turned off.");
  const result = await ReportShare.updateOne(
    { _id: id, userId: req.user!._id, revokedAt: null },
    { revokedAt: new Date() },
  );
  if (result.matchedCount === 0) throw new HttpError(404, "That link was already turned off.");
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Public, read-only view of a shared report (no sign-in)
// ---------------------------------------------------------------------------

async function loadShared(token: string) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new HttpError(404, EXPIRED_LINK);

  const share = await ReportShare.findOne({ tokenHash: hashToken(token), revokedAt: null, expiresAt: { $gt: new Date() } }).lean();
  if (!share) throw new HttpError(404, EXPIRED_LINK);

  const user = await User.findById(share.userId).select("displayName gradeLevel").lean();
  if (!user) throw new HttpError(404, EXPIRED_LINK);

  const tz = share.timeZone || "UTC";
  const report = await withSummary(user, await buildReport(user, share.periodDays, tz));
  return { share, report, tz };
}

function privateHeaders(res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
}

reportRouter.get("/shared/:token", async (req, res) => {
  privateHeaders(res);
  const { share, report, tz } = await loadShared(req.params.token);
  res.json({ report, document: reportDocument(report, tz), expiresAt: share.expiresAt });
});

reportRouter.get("/shared/:token/docx", async (req, res) => {
  privateHeaders(res);
  const { report, tz } = await loadShared(req.params.token);
  sendDocx(res, await reportDocx(report, tz), report);
});
