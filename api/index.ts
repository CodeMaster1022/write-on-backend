import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Vercel serverless entrypoint. Vercel reuses warm instances across
 * requests, so the Express app and the Mongo connection are built once
 * (not per invocation) — a fresh app/connection per request would be
 * needlessly slow and would leak Mongoose connection-event listeners on
 * every warm invocation.
 *
 * The app is imported lazily so a startup failure (e.g. missing env vars)
 * comes back as a readable JSON error instead of an opaque
 * FUNCTION_INVOCATION_FAILED crash.
 */
type App = (req: IncomingMessage, res: ServerResponse) => void;

let ready: Promise<App> | null = null;

async function init(): Promise<App> {
  const { createApp } = await import("../src/app.js");
  const { connectDb } = await import("../src/config/db.js");
  const app = createApp();
  await connectDb();
  return app as unknown as App;
}

function sendError(res: ServerResponse, status: number, error: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error }));
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!ready) {
    ready = init().catch((err) => {
      ready = null;
      throw err;
    });
  }

  let app: App;
  try {
    app = await ready;
  } catch (err) {
    console.error("[api] startup failed", err);
    sendError(res, 503, `Server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  app(req, res);
}
