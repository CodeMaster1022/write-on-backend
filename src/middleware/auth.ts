import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { User, type UserDoc } from "../models/User.js";
import { HttpError } from "./error.js";

export interface TokenPayload {
  sub: string;
  role: "student" | "teacher";
}

declare global {
  namespace Express {
    interface Request {
      user?: UserDoc;
    }
  }
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

function readBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = readBearer(req);
  if (!token) throw new HttpError(401, "Sign in to continue.");

  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as TokenPayload;
  } catch {
    throw new HttpError(401, "Your session expired. Please sign in again.");
  }

  const user = await User.findById(payload.sub);
  if (!user) throw new HttpError(401, "Account not found.");

  req.user = user;
  next();
}

export function requireTeacher(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== "teacher") {
    throw new HttpError(403, "This area is for teacher accounts.");
  }
  next();
}
