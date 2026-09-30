import { describe, expect, it } from "vitest";
import { databaseName, productionProblems, type ProductionSettings } from "../src/config/production.js";

const good: ProductionSettings = {
  MONGODB_URI: "mongodb+srv://app:pw@cluster0.abc.mongodb.net/write-on?retryWrites=true",
  JWT_SECRET: "4f9c2e7a1b8d3f6e0a5c9b2d7e1f4a8c6b3d0e9f2a7c5b1d",
  CLIENT_ORIGIN: "https://write-on.app,https://www.write-on.app",
  OPENAI_API_KEY: "sk-live",
  SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
  EMAIL_API_KEY: "re_live",
  CLOUDINARY_URL: "cloudinary://key:secret@live-cloud",
  ALLOW_HTTP: false,
};

describe("production settings check", () => {
  it("accepts a safe setup with no warnings", () => {
    expect(productionProblems(good)).toEqual({ problems: [], warnings: [] });
  });

  it("refuses a short or example sign-in secret", () => {
    expect(productionProblems({ ...good, JWT_SECRET: "short" }).problems).toHaveLength(1);
    expect(productionProblems({ ...good, JWT_SECRET: "replace-me-with-a-long-random-string-please" }).problems).toHaveLength(1);
  });

  it("refuses a database address with no database name, or a test database", () => {
    expect(productionProblems({ ...good, MONGODB_URI: "mongodb+srv://app:pw@cluster0.abc.mongodb.net/?retryWrites=true" }).problems[0]).toMatch(/"test"/);
    expect(productionProblems({ ...good, MONGODB_URI: "mongodb+srv://app:pw@cluster0.abc.mongodb.net/write-on-dev" }).problems[0]).toMatch(/test copy/);
  });

  it("reads the database name from addresses that list several hosts", () => {
    expect(databaseName("mongodb://u:p@h1:27017,h2:27017,h3:27017/write-on?ssl=true&replicaSet=rs0")).toBe("write-on");
    expect(databaseName("mongodb://u:p@h1:27017,h2:27017/?ssl=true")).toBe("");
    expect(databaseName("mongodb+srv://u:p@c.mongodb.net/write-on")).toBe("write-on");
    expect(productionProblems({ ...good, MONGODB_URI: "mongodb://u:p@h1:27017,h2:27017/write-on?ssl=true" }).problems).toEqual([]);
  });

  it("refuses local or plain-http website addresses", () => {
    const { problems } = productionProblems({ ...good, CLIENT_ORIGIN: "http://localhost:3000,http://207.241.172.34:3000" });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/local address/);
    expect(problems[1]).toMatch(/https/);
  });

  it("allows plain http only while ALLOW_HTTP is on, with a warning", () => {
    const result = productionProblems({ ...good, CLIENT_ORIGIN: "http://207.241.172.34:3000", ALLOW_HTTP: true });
    expect(result.problems).toEqual([]);
    expect(result.warnings[0]).toMatch(/ALLOW_HTTP/);
  });

  it("warns, without stopping, when optional services aren't set up", () => {
    const { problems, warnings } = productionProblems({ ...good, OPENAI_API_KEY: "", SENTRY_DSN: undefined, EMAIL_API_KEY: "", CLOUDINARY_URL: undefined });
    expect(problems).toEqual([]);
    expect(warnings).toHaveLength(4);
    expect(warnings.join(" ")).toMatch(/CLOUDINARY_URL/);
  });
});
