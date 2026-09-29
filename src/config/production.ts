/**
 * Checks run when the server starts with NODE_ENV=production. Problems stop
 * the server from starting; warnings are printed but don't.
 */
export interface ProductionSettings {
  MONGODB_URI: string;
  JWT_SECRET: string;
  CLIENT_ORIGIN: string;
  OPENAI_API_KEY?: string;
  SENTRY_DSN?: string;
  EMAIL_API_KEY?: string;
  ALLOW_HTTP: boolean;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];

/** The database name in a MongoDB address, including ones that list several hosts ("h1,h2,h3"), which URL() can't read. */
export function databaseName(uri: string): string {
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/?]+\/([^?]*)/);
  return match ? decodeURIComponent(match[1]!) : "";
}

export function productionProblems(s: ProductionSettings): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (s.JWT_SECRET.length < 32 || /replace-me|change-?me|secret123|example/i.test(s.JWT_SECRET)) {
    problems.push("JWT_SECRET must be a long random string (at least 32 characters), not the example value.");
  }

  const dbName = databaseName(s.MONGODB_URI);
  if (!dbName) {
    problems.push(
      'MONGODB_URI has no database name, so MongoDB would use one called "test". Add it to the address, e.g. ...mongodb.net/write-on?...',
    );
  } else if (/test|dev|staging|e2e/i.test(dbName)) {
    problems.push(`MONGODB_URI points at the "${dbName}" database, which looks like a test copy. The live site needs its own database.`);
  }

  for (const origin of s.CLIENT_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)) {
    let url: URL | null = null;
    try {
      url = new URL(origin);
    } catch {
      problems.push(`CLIENT_ORIGIN "${origin}" isn't a web address.`);
      continue;
    }
    if (LOCAL_HOSTS.includes(url.hostname)) {
      problems.push(`CLIENT_ORIGIN "${origin}" is a local address. List only the live website's address.`);
    } else if (url.protocol !== "https:" && !s.ALLOW_HTTP) {
      problems.push(`CLIENT_ORIGIN "${origin}" must use https://.`);
    }
  }

  if (s.ALLOW_HTTP) warnings.push("ALLOW_HTTP is on: requests without HTTPS are accepted. Turn it off once HTTPS is set up.");
  if (!s.OPENAI_API_KEY) warnings.push("OPENAI_API_KEY is not set: AI feedback, Ask Inki and read-aloud are off.");
  if (!s.SENTRY_DSN) warnings.push("SENTRY_DSN is not set: errors are only written to the server log, and nobody is alerted.");
  if (!s.EMAIL_API_KEY) warnings.push("EMAIL_API_KEY is not set: report emails can't be sent.");

  return { problems, warnings };
}
