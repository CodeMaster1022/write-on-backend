import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { redact, reportError } from "../lib/alerts.js";

/**
 * Crashes in students' browsers, passed on to the error alerts. Open to
 * guests (a crash can happen before sign-in), limited per device, and the
 * report carries only the error, the page path and the code location.
 */
export const clientErrorsRouter = Router();

clientErrorsRouter.use(
  rateLimit({ windowMs: 10 * 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false }),
);

const schema = z.object({
  kind: z.enum(["error", "unhandledrejection", "render"]),
  message: z.string().max(1000),
  stack: z.string().max(8000).optional(),
  /** The page path only. Any query string is dropped. */
  path: z.string().max(300),
});

clientErrorsRouter.post("/", (req, res) => {
  const body = schema.parse(req.body);

  const error = new Error(redact(body.message));
  error.name = `BrowserError(${body.kind})`;
  // Keep code locations only: the first stack line repeats the message, so it's replaced.
  const frames = (body.stack ?? "").split("\n").filter((l) => /^\s*at |@/.test(l)).slice(0, 20);
  error.stack = [`${error.name}: ${error.message}`, ...frames].join("\n");

  reportError(error, { source: "browser", route: body.path.split("?")[0]!.slice(0, 200) });
  res.status(204).send();
});
