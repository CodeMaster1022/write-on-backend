import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/error.js";

export const dictionaryRouter = Router();

const paramsSchema = z.object({
  word: z.string().trim().min(1).max(60),
});

interface ApiDefinition {
  definition: string;
  example?: string;
}

interface ApiMeaning {
  partOfSpeech: string;
  definitions: ApiDefinition[];
}

interface ApiEntry {
  word: string;
  phonetic?: string;
  meanings: ApiMeaning[];
}

/**
 * Free, no-key dictionary lookup for the "Define" tool in Noun Assistance
 * (and, later, the other parts-of-speech panels). Proxied through our own
 * server so we can normalize errors and swap providers later without
 * touching the client.
 */
dictionaryRouter.get("/:word", async (req, res) => {
  const { word } = paramsSchema.parse(req.params);

  let apiRes: Response;
  try {
    apiRes = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  } catch {
    throw new HttpError(502, "Couldn't reach the dictionary right now. Please try again.");
  }

  if (apiRes.status === 404) {
    throw new HttpError(404, `We couldn't find a definition for "${word}".`);
  }
  if (!apiRes.ok) {
    throw new HttpError(502, "Couldn't reach the dictionary right now. Please try again.");
  }

  const entries = (await apiRes.json()) as ApiEntry[];
  const entry = entries[0];
  if (!entry) {
    throw new HttpError(404, `We couldn't find a definition for "${word}".`);
  }

  // Keep it short for young readers: at most 2 meanings, 1 definition each.
  const meanings = entry.meanings.slice(0, 2).map((m) => ({
    partOfSpeech: m.partOfSpeech,
    definition: m.definitions[0]?.definition ?? "",
    example: m.definitions[0]?.example,
  }));

  res.json({ word: entry.word, phonetic: entry.phonetic ?? null, meanings });
});
