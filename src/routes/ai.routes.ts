import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";

export const aiRouter = Router();

aiRouter.use(requireAuth);

const WRITING_TYPES = ["sentence", "paragraph", "essay"] as const;

const bodySchema = z.object({
  type: z.enum(WRITING_TYPES),
  content: z.string().trim().min(1, "There's nothing to look at yet.").max(20_000),
});

const NOUN: Record<(typeof WRITING_TYPES)[number], string> = {
  sentence: "sentence",
  paragraph: "paragraph",
  essay: "essay",
};

const SYSTEM_PROMPT = `You are a warm, encouraging writing coach for K-12 students, including neurodivergent and English language learners. A student has just finished a draft and wants quick feedback before submitting it.

Write 2-3 short, specific, and encouraging suggestions for how they could improve it. Rules:
- Plain, simple sentences. No jargon, no grading, no letter/number scores.
- Always find something genuine to praise first, briefly.
- Suggestions must be concrete and actionable (e.g. "try adding a sound or smell to the setting"), never vague ("be more descriptive").
- Keep the whole reply to 3-5 sentences, friendly and conversational, as if talking directly to the student.
- Never mention that you are an AI model, and never discuss anything other than this piece of writing.`;

interface OpenAiChatResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * "Use AI to analyze for improvements" — operates on the in-progress draft
 * text from DraftReview, before it's ever saved as a Writing.
 */
aiRouter.post("/analyze", async (req, res) => {
  if (!env.OPENAI_API_KEY) {
    throw new HttpError(503, "AI feedback isn't set up yet. Add OPENAI_API_KEY to the server .env file.");
  }

  const { type, content } = bodySchema.parse(req.body);

  let apiRes: Response;
  try {
    apiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        temperature: 0.7,
        max_tokens: 220,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Here is my ${NOUN[type]}:\n\n${content}` },
        ],
      }),
    });
  } catch {
    throw new HttpError(502, "Couldn't reach the AI feedback service right now. Please try again.");
  }

  if (!apiRes.ok) {
    // Don't leak upstream error details (may include account/billing info).
    console.error("[ai] OpenAI request failed", apiRes.status, await apiRes.text().catch(() => ""));
    throw new HttpError(502, "Couldn't get AI feedback right now. Please try again in a moment.");
  }

  const data = (await apiRes.json()) as OpenAiChatResponse;
  const feedback = data.choices?.[0]?.message?.content?.trim();

  if (!feedback) {
    throw new HttpError(502, "Couldn't get AI feedback right now. Please try again in a moment.");
  }

  res.json({ feedback });
});
