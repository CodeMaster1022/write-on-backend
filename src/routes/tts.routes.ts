import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";

export const ttsRouter = Router();

ttsRouter.use(requireAuth);

const CACHE_DIR = path.resolve("tts-cache");

const bodySchema = z.object({
  // Covers both short static prompts and a full generated essay draft.
  // OpenAI's TTS caps input at 4096 characters — stay safely under that.
  text: z.string().trim().min(1).max(4000),
});

/**
 * Read-aloud for prompts, a student's generated draft, and AI feedback.
 * POST (not GET) since a full essay draft is far too long to ride safely in
 * a URL query string. Static, repeated phrases (like the guest home's
 * prompts) are synthesized once and cached on disk; one-off text (a
 * particular student's essay) still gets cached, it just won't get a second
 * hit unless the exact same text is read again.
 */
ttsRouter.post("/", async (req, res) => {
  if (!env.OPENAI_API_KEY) {
    throw new HttpError(503, "Read-aloud isn't set up yet. Add OPENAI_API_KEY to the server .env file.");
  }

  const { text } = bodySchema.parse(req.body);

  const key = createHash("sha256")
    .update(`${env.OPENAI_TTS_MODEL}|${env.OPENAI_TTS_VOICE}|${text}`)
    .digest("hex");
  const cachePath = path.join(CACHE_DIR, `${key}.mp3`);

  const cached = await readFile(cachePath).catch(() => null);
  if (cached) {
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
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

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath, audio).catch((err) => {
    // Caching is an optimization, not a requirement — still serve the audio if the write fails.
    console.error("[tts] failed to write cache file", err);
  });

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.send(audio);
});
