import { beforeAll, describe, expect, it } from "vitest";
import { LESSON_INK_DROPS, Lesson, LessonAttempt } from "../src/models/Lesson.js";
import { User } from "../src/models/User.js";
import { fakeOpenAi } from "./fake-network.js";
import { api, bearer, seedBasics, signUp, signUpAdmin, type TestUser } from "./helpers.js";

const HOUR = 60 * 60 * 1000;
let admin: TestUser;

beforeAll(async () => {
  await seedBasics();
  admin = await signUpAdmin();
});

const STEPS = [
  { question: "Which word is a transition word?", kind: "choice", choices: ["banana", "first", "blue"], answer: 1 },
  { question: "Write a sentence that starts with 'Next'.", kind: "written", example: "Next, I brushed my teeth." },
  { question: "Which sentence shows order?", kind: "choice", choices: ["I like dogs.", "First, I woke up."], answer: 1 },
];

async function createLesson(overrides: Record<string, unknown> = {}) {
  const res = await api()
    .post("/api/admin/lessons")
    .set(bearer(admin.token))
    .send({
      title: "Transition words",
      teach: "Transition words are signposts. They tell the reader what comes next.",
      example: "First, I cracked the eggs.",
      startsAt: new Date(Date.now() - HOUR).toISOString(),
      steps: STEPS,
      ...overrides,
    });
  if (res.status !== 201) throw new Error(`lesson create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

const complete = (token: string, id: string, answers: unknown[]) =>
  api().post(`/api/lessons/${id}/complete`).set(bearer(token)).send({ answers });

describe("writing lessons (admin)", () => {
  it("keeps students out", async () => {
    const student = await signUp();
    for (const [method, path] of [
      ["get", "/api/admin/lessons"],
      ["post", "/api/admin/lessons"],
    ] as const) {
      const res = await api()[method](path).set(bearer(student.token)).send({});
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("checks each step: choices need 2+ answers and a right one, and no more than 6 steps", async () => {
    const base = { title: "T", teach: "Teach.", startsAt: new Date().toISOString() };
    const post = (steps: unknown[]) => api().post("/api/admin/lessons").set(bearer(admin.token)).send({ ...base, steps });

    expect((await post([])).status).toBe(400);
    expect((await post([{ question: "Q", kind: "choice", choices: ["only one"], answer: 0 }])).status).toBe(400);
    expect((await post([{ question: "Q", kind: "choice", choices: ["a", "b"], answer: 5 }])).status).toBe(400);
    expect((await post([{ question: "Q", kind: "choice", choices: ["a", "b"] }])).status).toBe(400);
    expect((await post(Array.from({ length: 7 }, () => ({ question: "Q", kind: "written" })))).status).toBe(400);
    expect((await post([{ question: "Q", kind: "written" }])).status).toBe(201);
  });

  it("drops stray choices from a written step and the example from a choice step", async () => {
    const id = await createLesson({
      steps: [
        { question: "W", kind: "written", choices: ["left", "over"], answer: 1 },
        { question: "C", kind: "choice", choices: ["a", "b"], answer: 0, example: "stray" },
      ],
    });
    const lesson = await Lesson.findById(id).lean();
    expect(lesson!.steps[0]).toMatchObject({ kind: "written", choices: [], answer: null });
    expect(lesson!.steps[1]).toMatchObject({ kind: "choice", example: "" });
  });

  it("lists lessons with a status and how many students finished", async () => {
    await Lesson.deleteMany({});
    const past = await createLesson({ title: "Old lesson", startsAt: new Date(Date.now() - 30 * 24 * HOUR).toISOString() });
    const current = await createLesson({ title: "Now lesson" });
    const scheduled = await createLesson({ title: "Future lesson", startsAt: new Date(Date.now() + 24 * HOUR).toISOString() });

    const student = await signUp();
    await complete(student.token, current, [1, "Next, I ate.", 1]);

    const res = await api().get("/api/admin/lessons").set(bearer(admin.token));
    const byId = new Map(res.body.lessons.map((l: { id: string }) => [l.id, l]));
    expect(byId.get(past)).toMatchObject({ status: "past", finishedCount: 0 });
    expect(byId.get(current)).toMatchObject({ status: "current", finishedCount: 1 });
    expect(byId.get(scheduled)).toMatchObject({ status: "scheduled", finishedCount: 0 });
    // Erin sees the right answers; they're part of editing.
    expect(byId.get(current)).toMatchObject({ steps: [expect.objectContaining({ answer: 1 }), expect.anything(), expect.anything()] });
  });

  it("locks the steps once a student has done the practice, but the teaching text can still change", async () => {
    const id = await createLesson();
    const student = await signUp();
    await complete(student.token, id, [1, "Next, I ran.", 1]);

    const text = await api().patch(`/api/admin/lessons/${id}`).set(bearer(admin.token)).send({ teach: "Better words." });
    expect(text.status).toBe(200);
    const sameSteps = await api().patch(`/api/admin/lessons/${id}`).set(bearer(admin.token)).send({ steps: STEPS });
    expect(sameSteps.status).toBe(200);
    const changed = await api()
      .patch(`/api/admin/lessons/${id}`)
      .set(bearer(admin.token))
      .send({ steps: [{ question: "Different", kind: "written" }] });
    expect(changed.status).toBe(400);
  });

  it("shows results: a count per choice, and the written answers with the student's name", async () => {
    const id = await createLesson();
    const a = await signUp({ displayName: "Ava", gradeLevel: "3" });
    const b = await signUp({ displayName: "Ben" });
    await complete(a.token, id, [1, "Next, I ate toast.", 0]);
    await complete(b.token, id, [0, "Next, I played.", 1]);

    const res = await api().get(`/api/admin/lessons/${id}/results`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ finished: 2, choiceTotal: 2, averageScore: 1 });
    expect(res.body.steps[0]).toMatchObject({ kind: "choice", answer: 1, picks: [1, 1, 0] });
    expect(res.body.steps[1].kind).toBe("written");
    expect(res.body.steps[1].written).toEqual(
      expect.arrayContaining([
        { student: "Ava", grade: "3", text: "Next, I ate toast." },
        { student: "Ben", grade: "4", text: "Next, I played." },
      ]),
    );
  });

  it("deletes a lesson with its results, and records what it did", async () => {
    const id = await createLesson({ title: "Gone lesson" });
    const student = await signUp();
    await complete(student.token, id, [1, "Next.", 1]);

    const res = await api().delete(`/api/admin/lessons/${id}`).set(bearer(admin.token));
    expect(res.body).toMatchObject({ ok: true, resultsRemoved: 1 });
    expect(await LessonAttempt.countDocuments({ lessonId: id })).toBe(0);

    const activity = await api().get("/api/admin/activity").set(bearer(admin.token));
    const kinds = activity.body.actions
      .filter((x: { lesson: string | null }) => x.lesson === "Gone lesson")
      .map((x: { kind: string }) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(["lesson_create", "lesson_delete"]));
  });
});

describe("doing a lesson (student)", () => {
  it("shows the newest started lesson as this week's, keeps earlier ones, and hides scheduled ones", async () => {
    await Lesson.deleteMany({});
    const older = await createLesson({ title: "Older", startsAt: new Date(Date.now() - 20 * 24 * HOUR).toISOString() });
    const newest = await createLesson({ title: "Newest", startsAt: new Date(Date.now() - 2 * HOUR).toISOString() });
    const future = await createLesson({ title: "Future", startsAt: new Date(Date.now() + 2 * HOUR).toISOString() });

    const student = await signUp();
    const res = await api().get("/api/lessons").set(bearer(student.token));
    expect(res.body.current).toMatchObject({ id: newest, title: "Newest", stepCount: 3, inkDrops: LESSON_INK_DROPS, mine: null });
    expect(res.body.past.map((l: { id: string }) => l.id)).toEqual([older]);

    expect((await api().get(`/api/lessons/${future}`).set(bearer(student.token))).status).toBe(404);
    expect((await complete(student.token, future, ["x"])).status).toBe(404);
  });

  it("never sends the right answers before the student finishes", async () => {
    const id = await createLesson();
    const student = await signUp();
    const res = await api().get(`/api/lessons/${id}`).set(bearer(student.token));
    expect(res.status).toBe(200);
    expect(res.body.lesson.teach).toContain("signposts");
    expect(res.body.lesson.steps[0]).toEqual({ question: STEPS[0]!.question, kind: "choice", choices: ["banana", "first", "blue"], example: "" });
    expect(JSON.stringify(res.body)).not.toContain('"answer"');
  });

  it("marks each choice, saves written answers, and pays the ink drops once", async () => {
    const id = await createLesson();
    const student = await signUp();
    const before = (await User.findById(student.id).lean())!.inkDrops;

    const first = await complete(student.token, id, [1, "Next, I brushed my teeth.", 0]);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      results: [
        { correct: true, correctChoice: 1 },
        { correct: null, correctChoice: null },
        { correct: false, correctChoice: 1 },
      ],
      score: 1,
      choiceCount: 2,
      inkDropsEarned: LESSON_INK_DROPS,
    });
    expect(first.body.user.inkDrops).toBe(before + LESSON_INK_DROPS);

    const again = await complete(student.token, id, [1, "Next, I ran outside.", 1]);
    expect(again.body).toMatchObject({ score: 2, inkDropsEarned: 0 });
    expect((await User.findById(student.id).lean())!.inkDrops).toBe(before + LESSON_INK_DROPS);

    const attempts = await LessonAttempt.find({ userId: student.id, lessonId: id }).lean();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ score: 2, tries: 2, inkDropsAwarded: LESSON_INK_DROPS });
    expect(attempts[0]!.answers[1]!.text).toBe("Next, I ran outside.");

    const list = await api().get("/api/lessons").set(bearer(student.token));
    const mine = [list.body.current, ...list.body.past].find((l: { id: string }) => l.id === id).mine;
    expect(mine).toMatchObject({ score: 2, choiceCount: 2, tries: 2 });
  });

  it("runs written answers through the safety filter before Erin sees them", async () => {
    const id = await createLesson();
    const student = await signUp();
    fakeOpenAi.flagged = true;
    const res = await complete(student.token, id, [1, "Something unsuitable.", 1]);
    fakeOpenAi.flagged = false;
    expect(res.status).toBe(400);
    expect(await LessonAttempt.countDocuments({ userId: student.id })).toBe(0);
  });

  it("refuses incomplete or mismatched answers", async () => {
    const id = await createLesson();
    const student = await signUp();
    expect((await complete(student.token, id, [1, "Next."])).status).toBe(400);
    expect((await complete(student.token, id, ["word", "Next.", 1])).status).toBe(400);
    expect((await complete(student.token, id, [9, "Next.", 1])).status).toBe(400);
    expect((await complete(student.token, id, [1, "", 1])).status).toBe(400);
    expect(await LessonAttempt.countDocuments({ userId: student.id })).toBe(0);
  });

  it("earns the lesson badges on the progress page", async () => {
    const id = await createLesson();
    const student = await signUp();
    await complete(student.token, id, [1, "Next.", 1]);
    const res = await api().get("/api/progress/me").set(bearer(student.token));
    const badge = res.body.badges.find((b: { key: string }) => b.key === "first_lesson");
    expect(badge.earnedAt).not.toBeNull();
    expect(res.body.badges.find((b: { key: string }) => b.key === "five_lessons")).toMatchObject({ earnedAt: null, progress: { current: 1, target: 5 } });
  });

  it("nudges the admin overview when nothing is scheduled to follow this week's lesson", async () => {
    await Lesson.deleteMany({});
    const none = await api().get("/api/admin/overview").set(bearer(admin.token));
    expect(none.body.attention.find((a: { key: string }) => a.key === "lesson").message).toContain("no weekly lesson yet");

    await createLesson({ startsAt: new Date(Date.now() - 2 * HOUR).toISOString() });
    const fresh = await api().get("/api/admin/overview").set(bearer(admin.token));
    expect(fresh.body.attention.find((a: { key: string }) => a.key === "lesson")).toBeUndefined();

    await Lesson.updateMany({}, { startsAt: new Date(Date.now() - 8 * 24 * HOUR) });
    const stale = await api().get("/api/admin/overview").set(bearer(admin.token));
    expect(stale.body.attention.find((a: { key: string }) => a.key === "lesson").message).toContain("No lesson is scheduled");

    await createLesson({ startsAt: new Date(Date.now() + 24 * HOUR).toISOString() });
    const planned = await api().get("/api/admin/overview").set(bearer(admin.token));
    expect(planned.body.attention.find((a: { key: string }) => a.key === "lesson")).toBeUndefined();
  });
});
