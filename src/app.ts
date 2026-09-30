import express, { type RequestHandler } from "express";
import cors from "cors";
import helmetImport from "helmet";
import type { HelmetOptions } from "helmet";
import morgan from "morgan";
import { env, isProd } from "./config/env.js";
import { initAlerts } from "./lib/alerts.js";
import { errorHandler, notFound } from "./middleware/error.js";
import { clientErrorsRouter } from "./routes/client-errors.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { writingsRouter } from "./routes/writings.routes.js";
import { wordbankRouter } from "./routes/wordbank.routes.js";
import { rewardsRouter } from "./routes/rewards.routes.js";
import { teacherRouter } from "./routes/teacher.routes.js";
import { dictionaryRouter } from "./routes/dictionary.routes.js";
import { aiRouter } from "./routes/ai.routes.js";
import { ttsRouter } from "./routes/tts.routes.js";
import { sttRouter } from "./routes/stt.routes.js";
import { eventsRouter } from "./routes/events.routes.js";
import { inkiRouter } from "./routes/inki.routes.js";
import { reportRouter } from "./routes/report.routes.js";
import { contestsRouter } from "./routes/contests.routes.js";
import { adminRouter } from "./routes/admin.routes.js";
import { adminUsersRouter } from "./routes/admin-users.routes.js";
import { progressRouter } from "./routes/progress.routes.js";

// Some build environments (seen on Vercel) resolve helmet's dual CJS/ESM
// type declarations to the module namespace instead of unwrapping its
// default export, so TypeScript sees it as non-callable even though the
// real ESM runtime import is always the callable function. Assert the
// known-correct shape so the build is stable across environments.
const helmet = helmetImport as unknown as (options?: Readonly<HelmetOptions>) => RequestHandler;

export function createApp() {
  initAlerts();
  const app = express();

  // One proxy hop in front of us in production (Vercel, or nginx on the VPS),
  // so req.ip is the real client for the IP-keyed rate limiter.
  app.set("trust proxy", 1);

  // Students' writing must never travel unencrypted. The health check stays open for uptime monitors.
  if (isProd && !env.ALLOW_HTTP) {
    app.use((req, res, next) => {
      if (req.secure || req.path === "/api/health") return next();
      res.status(403).json({ error: "Write on! only works over a secure connection. Use https:// in the address." });
    });
  }

  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN.split(",").map((o) => o.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "200kb" }));
  if (env.NODE_ENV !== "test") app.use(morgan(isProd ? "combined" : "dev"));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "write-on-api", env: env.NODE_ENV });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/writings", writingsRouter);
  app.use("/api/wordbank", wordbankRouter);
  app.use("/api/rewards", rewardsRouter);
  app.use("/api/teacher", teacherRouter);
  app.use("/api/dictionary", dictionaryRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/tts", ttsRouter);
  app.use("/api/stt", sttRouter);
  app.use("/api/events", eventsRouter);
  app.use("/api/inki", inkiRouter);
  app.use("/api/report", reportRouter);
  app.use("/api/contests", contestsRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/admin", adminUsersRouter);
  app.use("/api/progress", progressRouter);
  app.use("/api/client-errors", clientErrorsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
