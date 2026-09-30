import "dotenv/config";
import { z } from "zod";
import { productionProblems } from "./production.js";

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
  /** Where read-aloud audio for the app's fixed prompts is kept. Tests point this at a temporary folder. */
  TTS_CACHE_DIR: z.string().optional(),
  /**
   * Cloudinary keeps a lasting copy of the read-aloud audio for the app's own instructions, so a
   * server restart doesn't mean paying to voice them again. Format: cloudinary://<key>:<secret>@<cloud name>
   */
  CLOUDINARY_URL: z
    .string()
    .optional()
    .refine((v) => !v || /^cloudinary:\/\/[^:@/]+:[^@/]+@[^/?#]+$/.test(v.trim()), "CLOUDINARY_URL should look like cloudinary://<api key>:<api secret>@<cloud name>"),

  // Real-time speech-to-text ("dictate" mic button on answer fields).
  // Get a key at https://console.deepgram.com.
  DEEPGRAM_API_KEY: z.string().optional(),

  // Emailing progress reports. Get a key at https://resend.com. The sending
  // address's domain must be verified in Resend; onboarding@resend.dev only
  // delivers to the Resend account owner's own inbox (fine for testing).
  EMAIL_API_KEY: z.string().optional(),

  // Error alerts. Optional: without it, errors are only written to the server log.
  SENTRY_DSN: z.string().optional(),

  // Production only: accept requests that didn't come over HTTPS. Leave off
  // once HTTPS is set up; it exists so a server can be moved over in steps.
  ALLOW_HTTP: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  EMAIL_FROM: z.string().default("Write on! <onboarding@resend.dev>"),
  /** The website address used in links inside emails. Defaults to the first CLIENT_ORIGIN. */
  APP_URL: z.string().url().optional(),
});

const parsed = schema.safeParse(process.env);

const issues: string[] = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
if (parsed.success && parsed.data.NODE_ENV === "production") {
  const { problems, warnings } = productionProblems(parsed.data);
  issues.push(...problems);
  for (const w of warnings) console.warn(`[config] ${w}`);
}

if (!parsed.success || issues.length > 0) {
  const message = `Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}\n\nCopy .env.example to .env and fill it in.`;
  // On Vercel, exiting kills the function with an opaque error; throwing
  // lets api/index.ts report which variables are missing.
  if (process.env.VERCEL) throw new Error(message);
  console.error(message);
  process.exit(1);
}

export const env = parsed.data!;

export const isProd = env.NODE_ENV === "production";
