import { env } from "../config/env.js";
import { HttpError } from "../middleware/error.js";

interface ChatJsonOptions {
  system: string;
  user: string;
  schemaName: string;
  /** JSON schema for OpenAI structured output (strict mode). */
  schema: Record<string, unknown>;
  maxTokens: number;
  temperature?: number;
  /** Friendly message shown to the student if anything goes wrong. */
  failMessage: string;
}

interface OpenAiChatResponse {
  choices?: { message?: { content?: string } }[];
}

async function post(path: string, body: unknown, failMessage: string, label: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`https://api.openai.com/v1/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new HttpError(502, failMessage);
  }

  if (!res.ok) {
    // Don't leak upstream error details (may include account/billing info).
    console.error(`[${label}] OpenAI request failed`, res.status, await res.text().catch(() => ""));
    throw new HttpError(502, failMessage);
  }

  return res.json();
}

/** Chat completion that must return JSON matching `schema`. Returns the parsed (not yet validated) object. */
export async function chatJson(opts: ChatJsonOptions, label: string): Promise<unknown> {
  const data = (await post(
    "chat/completions",
    {
      model: env.OPENAI_MODEL,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens,
      response_format: {
        type: "json_schema",
        json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
      },
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    },
    opts.failMessage,
    label,
  )) as OpenAiChatResponse;

  try {
    return JSON.parse(data.choices?.[0]?.message?.content ?? "");
  } catch {
    console.error(`[${label}] response wasn't valid JSON`);
    throw new HttpError(502, opts.failMessage);
  }
}

interface ModerationResponse {
  results?: { flagged?: boolean }[];
}

/**
 * True if any input is unsafe. Fails closed: if the check itself can't run,
 * this throws rather than letting unchecked text through to children.
 */
export async function isFlagged(inputs: string[], failMessage: string): Promise<boolean> {
  const texts = inputs.map((t) => t.trim()).filter(Boolean);
  if (texts.length === 0) return false;

  const data = (await post(
    "moderations",
    { model: "omni-moderation-latest", input: texts },
    failMessage,
    "moderation",
  )) as ModerationResponse;

  if (!data.results || data.results.length !== texts.length) {
    throw new HttpError(502, failMessage);
  }
  return data.results.some((r) => r.flagged);
}
