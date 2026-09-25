import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_EXPIRES_IN: z.string().default("30d"),
  CLIENT_ORIGIN: z.string().default("http://localhost:3000"),

  // Optional: the "Use AI to analyze for improvements" feature is disabled
  // (returns a clear error) until this is set, rather than the whole server
  // failing to boot.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),

  // Read-aloud ("Play audio" buttons). Reuses OPENAI_API_KEY above.
  // Female voice options: nova, shimmer. Male/neutral: alloy, echo, fable, onyx.
  OPENAI_TTS_MODEL: z.string().default("tts-1"),
  OPENAI_TTS_VOICE: z.string().default("nova"),

  // Real-time speech-to-text ("dictate" mic button on answer fields).
  // Get a key at https://console.deepgram.com.
  DEEPGRAM_API_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  const message = `Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`;
  // On Vercel, exiting kills the function with an opaque error; throwing
  // lets api/index.ts report which variables are missing.
  if (process.env.VERCEL) throw new Error(message);
  console.error(message);
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === "production";
