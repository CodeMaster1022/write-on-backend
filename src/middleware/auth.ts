import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { User, parentApproved, type UserDoc } from "../models/User.js";
import { HttpError } from "./error.js";

export const PARENT_APPROVAL_CODE = "parent_approval_needed";

/** Shown while the account is paused. The account routes stay open so the student can fix the parent's email, resend, or delete the account. */
function parentHoldMessage(user: UserDoc): string {
  return user.parentEmail
    ? `Your account is waiting for a parent to approve it. We emailed ${user.parentEmail}.`
    : "A parent or guardian needs to approve your account before you can use it. Add their email on your account page.";
}

export interface TokenPayload {
  sub: string;
  role: "student" | "teacher";
  /** The account's session version when this session started. */
  v?: number;
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
  if (user.isGuest) throw new HttpError(401, "Trying Write on! without an account has changed. Please log in or create an account.");
  if ((payload.v ?? 0) !== (user.sessionVersion ?? 0)) {
    throw new HttpError(401, "Your password was changed. Please sign in again.");
  }

  // A paused student account can only reach the account routes (see who's approving, resend, export, delete).
  const path = req.originalUrl.split("?")[0] ?? "";
  if (!parentApproved(user) && !path.startsWith("/api/auth/")) {
    throw new HttpError(403, parentHoldMessage(user), { code: PARENT_APPROVAL_CODE });
  }

  req.user = user;
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) {
    throw new HttpError(403, "This area is for Write on! admins.");
  }
  next();
}

export function requireTeacher(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== "teacher") {
    throw new HttpError(403, "This area is for teacher accounts.");
  }
  next();
}
