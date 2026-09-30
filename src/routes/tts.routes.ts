import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { getAudioFromCloud, saveAudioToCloud } from "../lib/audio-store.js";
import { promptTtsLimiter, ttsLimiter } from "../middleware/rate-limit.js";

export const ttsRouter = Router();

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
 * Turns text into speech, reusing a saved copy when `keep` is set. Only the app's own
 * short prompts are ever saved; audio of a student's writing is generated, sent, and not kept.
 */
async function speech(text: string, keep: boolean): Promise<{ audio: Buffer; cacheControl: string }> {
  const key = createHash("sha256")
    .update(`${env.OPENAI_TTS_MODEL}|${env.OPENAI_TTS_VOICE}|${text}`)
    .digest("hex");
  const cachePath = path.join(CACHE_DIR, `${key}.mp3`);
  const cacheControl = keep ? "public, max-age=31536000, immutable" : "no-store";

  const cached = keep ? await readFile(cachePath).catch(() => null) : null;
  if (cached) return { audio: cached, cacheControl };

  // Not on this server's disk (a fresh restart, say): try the lasting copy before paying to voice it again.
  const stored = keep ? await getAudioFromCloud(key) : null;
  if (stored) {
    await writeLocal(cachePath, stored);
    return { audio: stored, cacheControl };
  }

  return generate(text, keep, key, cachePath, cacheControl);
}

async function writeLocal(cachePath: string, audio: Buffer) {
  try {
    // Caching is an optimization, not a requirement — still serve the audio if this fails.
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, audio);
  } catch (err) {
    console.error("[tts] failed to write cache file", err);
  }
}

async function generate(text: string, keep: boolean, key: string, cachePath: string, cacheControl: string) {
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
    await writeLocal(cachePath, audio);
    await saveAudioToCloud(key, audio);
  }
  return { audio, cacheControl };
}

function send(res: import("express").Response, audio: Buffer, cacheControl: string) {
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", cacheControl);
  res.send(audio);
}

function requireOpenAi() {
  if (!env.OPENAI_API_KEY) {
    throw new HttpError(503, "Read-aloud isn't set up yet. Add OPENAI_API_KEY to the server .env file.");
  }
}

/**
 * Read-aloud for signed-in students: prompts, a generated draft, and AI feedback.
 * POST (not GET) since a full essay draft is far too long to ride safely in
 * a URL query string.
 */
ttsRouter.post("/", requireAuth, ttsLimiter, async (req, res) => {
  requireOpenAi();
  const body = bodySchema.parse(req.body);
  const keep = body.keep && body.text.length <= MAX_KEPT_LENGTH;
  const { audio, cacheControl } = await speech(body.text, keep);
  send(res, audio, cacheControl);
});

// ---------------------------------------------------------------------------
// The app's own instructions, for people who haven't signed in
// ---------------------------------------------------------------------------

/** How many new sentences visitors can have voiced per day, so an open route can't run up the bill. Copies already saved are free. */
const VISITOR_NEW_AUDIO_PER_DAY = 400;
const visitorUsage = { day: "", generated: 0 };

const promptSchema = z.object({ text: z.string().trim().min(1).max(MAX_KEPT_LENGTH) });

/**
 * Voices the app's short instructions for visitors who haven't signed in, so young and
 * ELL writers can hear them. It always saves the audio for reuse, and it never takes a
 * draft: the browser reads a visitor's own writing with the device's built-in voice.
 */
ttsRouter.post("/prompt", promptTtsLimiter, async (req, res) => {
  requireOpenAi();
  const { text } = promptSchema.parse(req.body);

  const today = new Date().toISOString().slice(0, 10);
  if (visitorUsage.day !== today) Object.assign(visitorUsage, { day: today, generated: 0 });

  const key = createHash("sha256").update(`${env.OPENAI_TTS_MODEL}|${env.OPENAI_TTS_VOICE}|${text}`).digest("hex");
  const alreadySaved = await readFile(path.join(CACHE_DIR, `${key}.mp3`)).then(() => true, () => false);
  if (!alreadySaved) {
    if (visitorUsage.generated >= VISITOR_NEW_AUDIO_PER_DAY) {
      throw new HttpError(429, "Read-aloud is resting for today. Log in to keep listening, or try again tomorrow.");
    }
    visitorUsage.generated += 1;
  }

  const { audio, cacheControl } = await speech(text, true);
  send(res, audio, cacheControl);
});
