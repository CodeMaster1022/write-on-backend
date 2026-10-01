import type { Request } from "express";
import { rateLimit } from "express-rate-limit";
import { HttpError } from "./error.js";

const MINUTE = 60_000;

/**
 * Short-window burst limiters for the endpoints that cost money (OpenAI calls)
 * or do heavy work (report building). Signed-in routes key by user id, so a
 * whole classroom behind one school IP isn't throttled as a group; the public
 * shared-report route keys by IP.
 *
 * Counts live in memory, so on Vercel each warm instance counts separately.
 * That's fine for burst protection — the exact ceilings are the DB-backed
 * daily counters (Inki questions, AI feedback runs, report emails).
 */
function limiter(opts: { windowMs: number; limit: number; message: string; byUser: boolean }) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    ...(opts.byUser ? { keyGenerator: (req: Request) => String(req.user!._id) } : {}),
    handler: (_req, _res, next) => next(new HttpError(429, opts.message)),
  });
}

/** POST /api/ai/analyze — each call is an OpenAI request. */
export const analyzeLimiter = limiter({
  windowMs: 10 * MINUTE,
  limit: 10,
  byUser: true,
  message: "That's a lot of feedback checks in a row! Take a few minutes to work on your writing, then try again.",
});

/** POST /api/inki/define and /check — moderation + chat calls per question. */
export const inkiLimiter = limiter({
  windowMs: 5 * MINUTE,
  limit: 10,
  byUser: true,
  message: "Inki needs a short breather! Try again in a few minutes.",
});

/**
 * POST /api/tts — a builder page warms ~30 prompts on mount (served from the
 * server's disk cache after the first time), so the ceiling is generous;
 * this only stops runaway loops from generating new audio nonstop.
 */
export const ttsLimiter = limiter({
  windowMs: 10 * MINUTE,
  limit: 120,
  byUser: true,
  message: "Read-aloud needs a short break. Try again in a few minutes.",
});

/** The signed-in report routes: building, exporting, emailing, share links. */
export const reportLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 30,
  byUser: true,
  message: "Too many report requests right now. Please wait a few minutes and try again.",
});

/** Public shared-report view — keyed by IP since there's no sign-in. */
export const sharedReportLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 60,
  byUser: false,
  message: "Too many requests. Please wait a few minutes and try again.",
});

/** POST /api/stt/token — each call mints a Deepgram token; one per dictation is plenty. */
export const sttLimiter = limiter({
  windowMs: 10 * MINUTE,
  limit: 30,
  byUser: true,
  message: "Voice typing needs a short break. Try again in a few minutes, or type for now.",
});

/**
 * POST /api/auth/login — keyed by the email being tried, and only failed tries count,
 * so a whole classroom can still sign in from one school address.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * MINUTE,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    return typeof email === "string" ? email.trim().toLowerCase() : "no-email";
  },
  handler: (_req, _res, next) =>
    next(new HttpError(429, "Too many sign-in tries for that email. Please wait 15 minutes, or reset your password.")),
});

/**
 * POST /api/tts/prompt — instructions voiced for visitors who haven't signed in. Keyed by
 * network address, and generous because a classroom can share one. Copies already saved are
 * cheap; a separate daily cap limits how many new ones can be made.
 */
export const promptTtsLimiter = limiter({
  windowMs: 10 * MINUTE,
  limit: 600,
  byUser: false,
  message: "Read-aloud needs a short break. Try again in a few minutes.",
});
