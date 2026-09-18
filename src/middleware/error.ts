import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import mongoose from "mongoose";
import { isProd } from "../config/env.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(new HttpError(404, `No route for ${req.method} ${req.path}`));
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Some fields need another look.",
      details: err.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
    });
    return;
  }

  if (err instanceof mongoose.Error.ValidationError) {
    res.status(400).json({
      error: "Some fields need another look.",
      details: Object.values(err.errors).map((e) => ({ field: e.path, message: e.message })),
    });
    return;
  }

  // Duplicate key (e.g. an email that already exists).
  if (typeof err === "object" && err !== null && (err as { code?: number }).code === 11000) {
    res.status(409).json({ error: "That value is already taken." });
    return;
  }

  console.error("[error]", err);
  res.status(500).json({
    error: "Something went wrong on our end.",
    ...(isProd ? {} : { details: err instanceof Error ? err.message : String(err) }),
  });
}
