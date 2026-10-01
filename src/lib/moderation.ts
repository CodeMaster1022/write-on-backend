import { env } from "../config/env.js";
import { HttpError } from "../middleware/error.js";
import { isFlagged } from "./openai.js";

export const NOT_FOR_SCHOOL = "Some of that writing isn't right for school. Please change it and try again.";
const CHECK_FAILED = "We couldn't check your writing right now. Please try again in a moment.";

let warned = false;

/**
 * Stops text a student wrote from being saved when the safety filter flags it.
 * Erin reads contest entries and lesson answers, and "Email me a copy" sends
 * writing out of the app, so everything a student saves goes through here.
 * Without an OpenAI key (a developer's machine) the check is skipped, once with
 * a warning; with a key it fails closed, like Inki's own checks.
 */
export async function requireSchoolSafe(texts: (string | null | undefined)[]): Promise<void> {
  const inputs = texts.filter((t): t is string => typeof t === "string" && t.trim() !== "");
  if (inputs.length === 0) return;
  if (!env.OPENAI_API_KEY) {
    if (!warned) console.warn("[moderation] OPENAI_API_KEY isn't set, so student writing isn't checked by the safety filter.");
    warned = true;
    return;
  }
  if (await isFlagged(inputs, CHECK_FAILED)) throw new HttpError(400, NOT_FOR_SCHOOL);
}
