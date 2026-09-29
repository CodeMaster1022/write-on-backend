import * as Sentry from "@sentry/node";
import { env } from "../config/env.js";

/**
 * Error alerts. Reports go to Sentry when SENTRY_DSN is set, and only to the
 * server log otherwise. Nothing a student wrote may leave the server this
 * way: request bodies, headers, cookies, query strings and breadcrumbs are
 * dropped, and any long quoted text in a message is removed.
 */

const MAX_MESSAGE = 300;
let enabled = false;

/** Removes quoted passages long enough to be someone's writing, and trims the rest. */
export function redact(text: string): string {
  return text
    .replace(/(["'“‘`])[^"'”’`\n]{30,}\1|“[^”\n]{30,}”|‘[^’\n]{30,}’/g, "[text removed]")
    .slice(0, MAX_MESSAGE);
}

/** Keeps the path of a URL, never its query string. */
function pathOnly(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    return new URL(url, "http://x").pathname;
  } catch {
    return url.split("?")[0];
  }
}

type AlertEvent = Parameters<NonNullable<Sentry.NodeOptions["beforeSend"]>>[0];

/** The last check before an event leaves the server. Exported for tests. */
export function scrubEvent<T extends AlertEvent>(event: T): T {
  if (event.request) {
    event.request = { method: event.request.method, url: pathOnly(event.request.url) };
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
  event.breadcrumbs = [];
  delete event.extra;
  if (event.message) event.message = redact(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = redact(ex.value);
    for (const frame of ex.stacktrace?.frames ?? []) {
      delete frame.vars;
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
    }
  }
  return event;
}

export function initAlerts() {
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    // Sentry collects all of these by default. A variable or a request body could hold a student's draft.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    beforeSend: (event) => scrubEvent(event),
  });
  enabled = true;
}

export interface AlertContext {
  /** e.g. "POST /api/writings" — the route, never the full URL. */
  route?: string;
  userId?: string;
  source?: "server" | "browser";
}

export function reportError(err: unknown, context: AlertContext = {}) {
  const message = redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  console.error(`[alert] ${context.source ?? "server"} ${context.route ?? ""} ${message}`.replace(/\s+/g, " "));
  if (!enabled) return;
  Sentry.withScope((scope) => {
    scope.setTag("source", context.source ?? "server");
    if (context.route) scope.setTag("route", context.route);
    if (context.userId) scope.setUser({ id: context.userId });
    Sentry.captureException(err);
  });
}
