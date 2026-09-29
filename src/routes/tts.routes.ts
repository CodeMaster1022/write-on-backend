import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { ttsLimiter } from "../middleware/rate-limit.js";

export const ttsRouter = Router();

ttsRouter.use(requireAuth);

// Vercel's filesystem is read-only outside /tmp (which is itself wiped
// between cold starts), so cache there when deployed on Vercel; elsewhere
// (the VPS, local dev) a project-relative dir persists across requests.
const CACHE_DIR =
  env.TTS_CACHE_DIR ?? (process.env.VERCEL ? path.join("/tmp", "tts-cache") : path.resolve("tts-cache"));

/** The app's own prompts are short; a cap keeps a whole draft from ever being saved. */
const MAX_KEPT_LENGTH = 600;

const bodySchema = z.object({
  // Covers both short static prompts and a full generated essay draft.
  // OpenAI's TTS caps input at 4096 characters — stay safely under that.
  text: z.string().trim().min(1).max(4000),
  /** True only for the app's fixed prompts. Student writing and AI feedback are never saved. */
  keep: z.boolean().default(false),
});

/**
 * Read-aloud for prompts, a student's generated draft, and AI feedback.
 * POST (not GET) since a full essay draft is far too long to ride safely in
 * a URL query string. Only the app's fixed prompts are cached on disk;
 * audio of a student's writing is generated, sent, and not kept.
 */
ttsRouter.post("/", ttsLimiter, async (req, res) => {
  if (!env.OPENAI_API_KEY) {
    throw new HttpError(503, "Read-aloud isn't set up yet. Add OPENAI_API_KEY to the server .env file.");
  }

  const body = bodySchema.parse(req.body);
  const { text } = body;
  const keep = body.keep && text.length <= MAX_KEPT_LENGTH;

  const key = createHash("sha256")
    .update(`${env.OPENAI_TTS_MODEL}|${env.OPENAI_TTS_VOICE}|${text}`)
    .digest("hex");
  const cachePath = path.join(CACHE_DIR, `${key}.mp3`);
  const cacheControl = keep ? "public, max-age=31536000, immutable" : "no-store";

  const cached = keep ? await readFile(cachePath).catch(() => null) : null;
  if (cached) {
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", cacheControl);
    res.send(cached);
    return;
  }

  let apiRes: Response;
  try {
    apiRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.OPENAI_TTS_MODEL,
        voice: env.OPENAI_TTS_VOICE,
        input: text,
        response_format: "mp3",
      }),
    });
  } catch {
    throw new HttpError(502, "Couldn't reach the read-aloud service right now.");
  }

  if (!apiRes.ok) {
    console.error("[tts] OpenAI request failed", apiRes.status, await apiRes.text().catch(() => ""));
    throw new HttpError(502, "Couldn't read that aloud right now. Please try again.");
  }

  const audio = Buffer.from(await apiRes.arrayBuffer());

  if (keep) {
    try {
      // Caching is an optimization, not a requirement — still serve the audio if this fails.
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cachePath, audio);
    } catch (err) {
      console.error("[tts] failed to write cache file", err);
    }
  }

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", cacheControl);
  res.send(audio);
});
