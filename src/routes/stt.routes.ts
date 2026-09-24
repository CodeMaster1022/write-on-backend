import { DeepgramClient } from "@deepgram/sdk";
import { Router } from "express";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";

export const sttRouter = Router();

sttRouter.use(requireAuth);

/**
 * Mints a short-lived Deepgram access token so the browser can open a live
 * transcription WebSocket directly (no audio proxied through our server).
 * Our real DEEPGRAM_API_KEY never leaves the server — Deepgram's REST
 * endpoints require a server-side call anyway (browsers hit CORS calling
 * them directly), so this is also the only place that can mint one.
 */
sttRouter.post("/token", async (_req, res) => {
  if (!env.DEEPGRAM_API_KEY) {
    throw new HttpError(503, "Voice typing isn't set up yet. Add DEEPGRAM_API_KEY to the server .env file.");
  }

  const client = new DeepgramClient({ apiKey: env.DEEPGRAM_API_KEY });

  let grant: { access_token: string; expires_in?: number };
  try {
    grant = await client.auth.v1.tokens.grant();
  } catch (err) {
    console.error("[stt] failed to mint Deepgram access token", err);
    throw new HttpError(502, "Couldn't start voice typing right now. Please try again.");
  }

  res.json({ accessToken: grant.access_token, expiresIn: grant.expires_in ?? 30 });
});
