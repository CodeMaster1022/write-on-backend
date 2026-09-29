import { beforeAll, describe, expect, it } from "vitest";
import { summarizeGoal } from "../src/lib/progress.js";
import { fakeOpenAi } from "./fake-network.js";
import { api, bearer, feedbackReply, saveWriting, seedBasics, signUp } from "./helpers.js";

beforeAll(seedBasics);

// A Wednesday. Its week starts Monday 2026-09-28.
const NOW = new Date("2026-09-30T12:00:00Z");
const piece = (iso: string) => ({ createdAt: new Date(iso), activeSeconds: 60 });
const pieces = (iso: string, n: number) => Array.from({ length: n }, () => piece(iso));

describe("weekly goal and streak", () => {
  it("counts weeks in a row that met the goal", () => {
    const g = summarizeGoal(
      [...pieces("2026-09-08T10:00:00Z", 2), ...pieces("2026-09-15T10:00:00Z", 3), ...pieces("2026-09-22T10:00:00Z", 1), ...pieces("2026-09-29T10:00:00Z", 2)],
      [{ weekStart: "2026-09-07", perWeek: 2 }],
      2,
      "UTC",
      NOW,
    );
    expect(g.weeks.slice(-4).map((w) => [w.weekStart, w.pieces, w.met])).toEqual([
      ["2026-09-07", 2, true],
      ["2026-09-14", 3, true],
      ["2026-09-21", 1, false],
      ["2026-09-28", 2, true],
    ]);
    expect(g.streak).toEqual({ current: 1, best: 2 });
    expect(g.thisWeek).toMatchObject({ pieces: 2, goal: 2, met: true });
    expect(g.recent).toEqual({ withGoal: 3, met: 2 });
  });

  it("doesn't break the streak during a week that isn't over yet", () => {
    const g = summarizeGoal(
      [...pieces("2026-09-15T10:00:00Z", 2), ...pieces("2026-09-22T10:00:00Z", 2)],
      [{ weekStart: "2026-09-14", perWeek: 2 }],
      2,
      "UTC",
      NOW,
    );
    expect(g.thisWeek.met).toBe(false);
    expect(g.streak.current).toBe(2);
  });

  it("judges each week by the goal set for it, so a lower goal can't build a streak backwards", () => {
    const g = summarizeGoal(
      ["2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29"].map((d) => piece(`${d}T10:00:00Z`)),
      [
        { weekStart: "2026-09-07", perWeek: 3 },
        { weekStart: "2026-09-28", perWeek: 1 },
      ],
      1,
      "UTC",
      NOW,
    );
    expect(g.streak).toEqual({ current: 1, best: 1 });
  });

  it("ignores weeks before any goal was set", () => {
    const g = summarizeGoal(pieces("2026-09-15T10:00:00Z", 5), [{ weekStart: "2026-09-28", perWeek: 2 }], 2, "UTC", NOW);
    expect(g.streak).toEqual({ current: 0, best: 0 });
    expect(g.weeks.find((w) => w.weekStart === "2026-09-14")).toMatchObject({ pieces: 5, goal: null, met: false });
  });

  it("puts a piece in the week it was written in the student's own time zone", () => {
    // Monday 02:00 in London time is still Sunday evening in New York.
    const late = [piece("2026-09-28T02:00:00Z")];
    const history = [{ weekStart: "2026-09-14", perWeek: 1 }];
    expect(summarizeGoal(late, history, 1, "UTC", NOW).thisWeek.pieces).toBe(1);
    const ny = summarizeGoal(late, history, 1, "America/New_York", NOW);
    expect(ny.thisWeek.pieces).toBe(0);
    expect(ny.weeks.find((w) => w.weekStart === "2026-09-21")?.pieces).toBe(1);
  });
});

describe("setting the weekly goal", () => {
  const setGoal = (token: string, perWeek: number | null) =>
    api().put("/api/progress/goal").set(bearer(token)).set("X-Timezone", "America/New_York").send({ perWeek });

  it("accepts only the offered choices", async () => {
    const student = await signUp();
    expect((await setGoal(student.token, 4)).status).toBe(400);
    expect((await setGoal(student.token, 0)).status).toBe(400);
    const ok = await setGoal(student.token, 3);
    expect(ok.status).toBe(200);
    expect(ok.body.goal).toMatchObject({ perWeek: 3, thisWeek: { goal: 3 } });
  });

  it("keeps one goal per week, and can be turned off", async () => {
    const student = await signUp();
    await setGoal(student.token, 3);
    await setGoal(student.token, 5);
    const off = await setGoal(student.token, null);
    expect(off.body.goal.perWeek).toBeNull();

    const data = await api().get("/api/auth/me/export").set(bearer(student.token));
    expect(data.body.profile.weeklyGoal).toBeNull();
    expect(data.body.profile.goalHistory).toHaveLength(1);
  });

  it("counts this week's pieces toward the goal", async () => {
    const student = await signUp();
    await setGoal(student.token, 2);
    await saveWriting(student.token, { type: "sentence", content: "One." });
    await saveWriting(student.token, { type: "sentence", content: "Two." });
    const res = await api().get("/api/progress/me").set(bearer(student.token)).set("X-Timezone", "America/New_York");
    expect(res.body.goal.thisWeek).toMatchObject({ pieces: 2, goal: 2, met: true });
    expect(res.body.goal.streak.current).toBe(1);
  });
});

describe("skills", () => {
  const area = (rating: number, category = "punctuation") => ({
    rating,
    praise: "Good.",
    issues: [{ quote: "", suggestion: "Try this.", category }],
  });

  async function check(token: string, grammar: number, category: string) {
    const clean = { rating: 2, praise: "Good.", issues: [] };
    fakeOpenAi.chatReplies.push(feedbackReply({ grammar: area(grammar, category), evidence: clean, flow: clean }));
    await api().post("/api/ai/analyze").set(bearer(token)).send({ type: "paragraph", content: "Some writing." });
  }

  it("shows the latest stars, the trend, and the most common thing to practise", async () => {
    const student = await signUp();
    await check(student.token, 1, "capitalization");
    await check(student.token, 1, "capitalization");
    await check(student.token, 3, "capitalization");
    await check(student.token, 3, "run_on");

    const res = await api().get("/api/progress/me").set(bearer(student.token));
    const grammar = res.body.skills.find((s: { area: string }) => s.area === "grammar");
    expect(grammar).toMatchObject({ checks: 4, latest: 3, trend: "up" });
    expect(grammar.history.map((h: { rating: number }) => h.rating)).toEqual([1, 1, 3, 3]);
    expect(res.body.practice).toMatchObject({ category: "capitalization", label: "Capital letters", count: 3 });
    expect(res.body.practice.tip).toMatch(/capital letter/);
  });

  it("has nothing to practise before any AI check", async () => {
    const student = await signUp();
    const res = await api().get("/api/progress/me").set(bearer(student.token));
    expect(res.body.practice).toBeNull();
    expect(res.body.skills.every((s: { checks: number; latest: null }) => s.checks === 0 && s.latest === null)).toBe(true);
  });
});

describe("badges", () => {
  const badge = (body: { badges: { key: string }[] }, key: string) => body.badges.find((b) => b.key === key) as Record<string, unknown>;

  it("are earned from what the student has done, with progress toward the rest", async () => {
    const student = await signUp();
    const first = await api().get("/api/progress/me").set(bearer(student.token));
    expect(badge(first.body, "first_piece")).toMatchObject({ earned: false });

    const p = await saveWriting(student.token, { type: "paragraph", content: "Cats nap all day." });
    await api().patch(`/api/writings/${p._id}`).set(bearer(student.token)).send({ content: "Cats nap all day long." });
    fakeOpenAi.chatReplies.push(
      feedbackReply({
        grammar: { rating: 3, praise: "", issues: [] },
        evidence: { rating: 3, praise: "", issues: [] },
        flow: { rating: 3, praise: "", issues: [] },
      }),
    );
    await api().post("/api/ai/analyze").set(bearer(student.token)).send({ type: "paragraph", content: "Cats nap." });

    const res = await api().get("/api/progress/me").set(bearer(student.token));
    expect(badge(res.body, "first_piece")).toMatchObject({ earned: true });
    expect(badge(res.body, "first_paragraph")).toMatchObject({ earned: true });
    expect(badge(res.body, "first_essay")).toMatchObject({ earned: false, progress: null });
    expect(badge(res.body, "reviser")).toMatchObject({ earned: true });
    expect(badge(res.body, "triple_star")).toMatchObject({ earned: true });
    expect(badge(res.body, "ten_pieces")).toMatchObject({ earned: false, progress: { current: 1, target: 10 } });
    expect(badge(res.body, "streak_3")).toMatchObject({ earned: false, progress: { current: 0, target: 3 } });
    expect(res.body.totals).toMatchObject({ pieces: 1, checks: 1 });
  });
});

describe("grown-up report", () => {
  it("adds a weekly goal section once the student has set a goal", async () => {
    const student = await signUp();
    await saveWriting(student.token, { type: "sentence", content: "One." });
    const heading = async () => {
      fakeOpenAi.chatReplies.push({ overview: "Doing well.", home: ["Read."], classroom: ["Write."] });
      const res = await api().get("/api/report/me?days=7").set(bearer(student.token));
      return res.body.document.sections.find((s: { heading: string }) => s.heading === "Weekly writing goal");
    };

    expect(await heading()).toBeUndefined();
    await api().put("/api/progress/goal").set(bearer(student.token)).send({ perWeek: 3 });
    const section = await heading();
    expect(section.paragraphs[0]).toContain("3 pieces a week. This week so far: 1.");
    expect(section.bullets[0]).toBe("Current streak: 0 weeks in a row");
  });
});
