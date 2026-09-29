import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redact, scrubEvent } from "../src/lib/alerts.js";
import { api, bearer, signUp } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const DRAFT = "My secret story about the purple dragon who lived under my bed";

describe("removing student text from alerts", () => {
  it("removes long quoted text and keeps short messages", () => {
    expect(redact(`Cast failed for value "${DRAFT}"`)).toBe("Cast failed for value [text removed]");
    expect(redact("Cannot read properties of undefined (reading 'x')")).toBe("Cannot read properties of undefined (reading 'x')");
    expect(redact("a".repeat(1000))).toHaveLength(300);
  });

  it("strips the request, the user, breadcrumbs and code context from an event", () => {
    const event = scrubEvent({
      message: `Failed on "${DRAFT}"`,
      request: {
        method: "POST",
        url: "https://api.example.com/api/writings?draft=secret",
        data: { content: DRAFT },
        headers: { authorization: "Bearer abc" },
        cookies: { session: "abc" },
        query_string: "draft=secret",
      },
      user: { id: "u1", email: "kid@example.com", ip_address: "1.2.3.4" },
      breadcrumbs: [{ message: DRAFT }],
      extra: { body: DRAFT },
      exception: {
        values: [
          {
            type: "Error",
            value: `Bad text "${DRAFT}"`,
            stacktrace: { frames: [{ filename: "a.ts", lineno: 1, vars: { content: DRAFT }, context_line: DRAFT, pre_context: [DRAFT] }] },
          },
        ],
      },
    } as never) as unknown as Record<string, unknown>;

    expect(JSON.stringify(event)).not.toContain("dragon");
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(event.request).toEqual({ method: "POST", url: "/api/writings" });
    expect(event.user).toEqual({ id: "u1" });
    expect(event.breadcrumbs).toEqual([]);
  });
});

describe("server crashes", () => {
  it("are reported by route, without the student's writing", async () => {
    const student = await signUp();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // Simulate the database going away mid-request.
    await mongoose.disconnect();
    try {
      const res = await api().post("/api/writings").set(bearer(student.token)).send({ type: "paragraph", content: DRAFT });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain("dragon");
    } finally {
      await mongoose.connect(process.env.MONGODB_URI!);
    }

    const alerts = logged.mock.calls.map((c) => c.join(" ")).filter((l) => l.startsWith("[alert]"));
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.join("\n")).not.toContain("dragon");
  });
});

describe("browser errors", () => {
  it("are passed on with the page path only, and with long text removed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await api()
      .post("/api/client-errors")
      .send({
        kind: "error",
        message: `Unexpected token in "${DRAFT}"`,
        stack: `Error: Unexpected token in "${DRAFT}"\n    at build (app.js:10:5)\n    at run (app.js:20:1)`,
        path: "/app/library/abc?draft=secret",
      });
    expect(res.status).toBe(204);

    const line = logged.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("browser"))!;
    expect(line).toContain("/app/library/abc");
    expect(line).toContain("[text removed]");
    expect(line).not.toContain("dragon");
    expect(line).not.toContain("secret");
  });

  it("refuses reports that aren't in the expected shape", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await api().post("/api/client-errors").send({ kind: "anything", message: "x", path: "/" })).status).toBe(400);
    expect((await api().post("/api/client-errors").send({ kind: "error", message: "x".repeat(2000), path: "/" })).status).toBe(400);
  });

  it("limits how many one device can send", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push((await api().post("/api/client-errors").send({ kind: "error", message: "boom", path: "/" })).status);
    }
    expect(statuses).toContain(429);
  });
});
