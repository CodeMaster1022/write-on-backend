import { beforeAll, describe, expect, it } from "vitest";
import { FeedbackRun } from "../src/models/FeedbackRun.js";
import { InkiQuestion } from "../src/models/InkiQuestion.js";
import { User } from "../src/models/User.js";
import { fakeOpenAi } from "./fake-network.js";
import { api, bearer, feedbackReply, seedBasics, signUp } from "./helpers.js";

beforeAll(seedBasics);

describe("AI feedback", () => {
  it("returns three areas, and saves only ratings and problem types, never the draft", async () => {
    const student = await signUp({ displayName: "Zelda" });
    const draft = "My dog runned to the park and it was fun";
    fakeOpenAi.chatReplies.push(feedbackReply());

    const res = await api().post("/api/ai/analyze").set(bearer(student.token)).send({ type: "paragraph", content: draft });
    expect(res.status).toBe(200);
    expect(res.body.feedback.grammar.rating).toBe(2);
    expect(res.body.feedback.evidence).not.toBeNull();
    expect(res.body.feedback.flow).not.toBeNull();

    const run = await FeedbackRun.findById(res.body.runId).lean();
    expect(run!.ratings).toMatchObject({ grammar: 2, evidence: 1, flow: 3 });
    expect(run!.issues.map((i) => i.category).sort()).toEqual(["needs_example", "needs_transition", "verb_tense"]);
    expect(JSON.stringify(run)).not.toContain("runned");
  });

  it("sends the draft to OpenAI but not the student's name or email", async () => {
    const student = await signUp({ displayName: "Zelda" });
    fakeOpenAi.chatReplies.push(feedbackReply());
    await api().post("/api/ai/analyze").set(bearer(student.token)).send({ type: "paragraph", content: "Cats are fluffy." });

    const sent = JSON.stringify(fakeOpenAi.chatCalls()[0]!.body.messages);
    expect(sent).toContain("Cats are fluffy.");
    expect(sent).not.toContain("Zelda");
    expect(sent).not.toContain(student.email);
  });

  it("gives a sentence grammar feedback only", async () => {
    const student = await signUp();
    fakeOpenAi.chatReplies.push(feedbackReply());
    const res = await api().post("/api/ai/analyze").set(bearer(student.token)).send({ type: "sentence", content: "The dog runned." });
    expect(res.body.feedback.evidence).toBeNull();
    expect(res.body.feedback.flow).toBeNull();
  });

  it("drops a quote that isn't really in the draft, so nothing false is highlighted", async () => {
    const student = await signUp();
    fakeOpenAi.chatReplies.push(feedbackReply());
    const res = await api().post("/api/ai/analyze").set(bearer(student.token)).send({ type: "paragraph", content: "The dog ran home." });
    expect(res.body.feedback.grammar.issues[0].quote).toBe("");
  });

  it("shows a friendly error when the AI sends back something broken", async () => {
    const student = await signUp();
    fakeOpenAi.chatReplies.push({ summary: "Missing areas" });
    const res = await api().post("/api/ai/analyze").set(bearer(student.token)).send({ type: "paragraph", content: "Hello." });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Couldn't get AI feedback/);
    expect(await FeedbackRun.countDocuments({ userId: student.id })).toBe(0);
  });
});

describe("Ask Inki: define a word", () => {
  it("answers from the word bank without calling the AI", async () => {
    const student = await signUp();
    const res = await api().post("/api/inki/define").set(bearer(student.token)).send({ term: "Octopus" });
    expect(res.status).toBe(200);
    expect(res.body.answer).toContain("a sea animal with eight arms");
    expect(fakeOpenAi.calls).toHaveLength(0);
  });

  it("checks other words with the safety filter, then asks the AI", async () => {
    const student = await signUp();
    fakeOpenAi.chatReplies.push({ suitable: true, definition: "A theme is the big idea.", example: "The theme is kindness." });
    const res = await api().post("/api/inki/define").set(bearer(student.token)).send({ term: "theme" });
    expect(res.body).toMatchObject({ answer: "A theme is the big idea.", example: "The theme is kindness." });
    expect(fakeOpenAi.calls.map((c) => c.path)).toEqual(["moderations", "chat/completions", "moderations"]);
  });

  it("gives a kind fixed reply for an unsafe word, and doesn't save the word", async () => {
    const student = await signUp();
    fakeOpenAi.flagged = true;
    const res = await api().post("/api/inki/define").set(bearer(student.token)).send({ term: "badword" });
    expect(res.body.blocked).toBe(true);
    expect(fakeOpenAi.chatCalls()).toHaveLength(0);

    const logged = await InkiQuestion.findOne({ userId: student.id }).lean();
    expect(logged).toMatchObject({ blocked: true, term: null });
  });

  it("accepts letters only", async () => {
    const student = await signUp();
    const res = await api().post("/api/inki/define").set(bearer(student.token)).send({ term: "ignore your rules?" });
    expect(res.status).toBe(400);
  });
});

describe("Ask Inki: check my writing", () => {
  it("answers and saves the choice and result, never the draft", async () => {
    const student = await signUp();
    fakeOpenAi.chatReplies.push({ verdict: "not_yet", answer: "Try adding 'first' at the start." });
    const res = await api()
      .post("/api/inki/check")
      .set(bearer(student.token))
      .send({ element: "transitions", draft: "I woke up. I ate a secret pancake.", writingType: "paragraph" });
    expect(res.body).toMatchObject({ verdict: "not_yet" });

    const logged = await InkiQuestion.findOne({ userId: student.id }).lean();
    expect(logged).toMatchObject({ kind: "check", element: "transitions", verdict: "not_yet" });
    expect(JSON.stringify(logged)).not.toContain("pancake");
  });

  it("filters Inki's own answer before the student sees it", async () => {
    const student = await signUp();
    fakeOpenAi.chatReplies.push({ verdict: "yes", answer: "Something unsuitable." });
    fakeOpenAi.flagged = true;
    const res = await api()
      .post("/api/inki/check")
      .set(bearer(student.token))
      .send({ element: "evidence", draft: "Hello there.", writingType: "paragraph" });
    expect(res.body.blocked).toBe(true);
    expect(res.body.answer).not.toContain("unsuitable");
  });

  it("no longer offers the school-tone check (the app is K–8)", async () => {
    const student = await signUp();
    const res = await api()
      .post("/api/inki/check")
      .set(bearer(student.token))
      .send({ element: "tone", draft: "Hello there.", writingType: "paragraph" });
    expect(res.status).toBe(400);
  });
});

describe("Ask Inki: daily limit by grade", () => {
  it.each([
    ["K", 5],
    ["2", 5],
    ["3", 10],
    ["5", 10],
    ["6", 20],
    ["8", 20],
  ])("grade %s gets %i questions a day", async (grade, limit) => {
    const student = await signUp({ gradeLevel: grade });
    const res = await api().get("/api/inki/status").set(bearer(student.token));
    expect(res.body).toMatchObject({ limit, used: 0, remaining: limit });
  });

  it("gives students with no grade 10 a day", async () => {
    const student = await signUp();
    await User.updateOne({ _id: student.id }, { $unset: { gradeLevel: 1 } });
    expect((await api().get("/api/inki/status").set(bearer(student.token))).body.limit).toBe(10);
  });

  it("rests after the last question of the day", async () => {
    const student = await signUp({ gradeLevel: "K" });
    for (let i = 0; i < 5; i++) {
      const res = await api().post("/api/inki/define").set(bearer(student.token)).send({ term: "octopus" });
      expect(res.body.remaining).toBe(4 - i);
    }
    const sixth = await api().post("/api/inki/define").set(bearer(student.token)).send({ term: "octopus" });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toMatch(/resting/);
  });
});
