import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env, isProd } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/error.js";
import { authRouter } from "./routes/auth.routes.js";
import { writingsRouter } from "./routes/writings.routes.js";
import { wordbankRouter } from "./routes/wordbank.routes.js";
import { rewardsRouter } from "./routes/rewards.routes.js";
import { teacherRouter } from "./routes/teacher.routes.js";
import { dictionaryRouter } from "./routes/dictionary.routes.js";
import { aiRouter } from "./routes/ai.routes.js";
import { ttsRouter } from "./routes/tts.routes.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN.split(",").map((o) => o.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "200kb" }));
  app.use(morgan(isProd ? "combined" : "dev"));

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

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
