import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../src/app.js";
import { connectDb } from "../src/config/db.js";

/**
 * Vercel serverless entrypoint. Vercel reuses warm instances across
 * requests, so the Express app and the Mongo connection are built once at
 * module scope (not per invocation) — a fresh app/connection per request
 * would be needlessly slow and would leak Mongoose connection-event
 * listeners on every warm invocation.
 */
const app = createApp();

let dbReady: Promise<void> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!dbReady) {
    dbReady = connectDb().catch((err) => {
      dbReady = null;
      throw err;
    });
  }

  try {
    await dbReady;
  } catch (err) {
    console.error("[api] database connection failed", err);
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Database is unavailable right now. Please try again." }));
    return;
  }

  app(req, res);
}
