import { beforeAll, describe, expect, it } from "vitest";
import { FeedbackRun } from "../src/models/FeedbackRun.js";
import { fakeOpenAi } from "./fake-network.js";
import { api, bearer, feedbackReply, saveWriting, seedBasics, signUp } from "./helpers.js";

beforeAll(seedBasics);

describe("saving writing", () => {
  it("earns ink drops by type and counts the piece", async () => {
    const student = await signUp();
    const res = await api().post("/api/writings").set(bearer(student.token)).send({ type: "paragraph", content: "One two three four." });
    expect(res.status).toBe(201);
    expect(res.body.inkDropsEarned).toBe(15);
    expect(res.body.writing.wordCount).toBe(4);
    expect(res.body.user).toMatchObject({ inkDrops: 15, writingCount: 1 });

    const essay = await api().post("/api/writings").set(bearer(student.token)).send({ type: "essay", content: "An essay." });
    expect(essay.body.user.inkDrops).toBe(45);
  });

  it("stops writing the safety filter flags, on save and on edit, and reports the check failing", async () => {
    const student = await signUp();
    const piece = await saveWriting(student.token, { type: "sentence", content: "A fine sentence." });

    fakeOpenAi.flagged = true;
    const save = await api().post("/api/writings").set(bearer(student.token)).send({ type: "sentence", content: "Something unsuitable." });
    expect(save.status).toBe(400);
    expect(save.body.error).toContain("isn't right for school");
    const edit = await api().patch(`/api/writings/${piece._id}`).set(bearer(student.token)).send({ content: "Something unsuitable." });
    expect(edit.status).toBe(400);
    // An unchanged piece isn't re-checked (nothing new to read).
    const sameText = await api().patch(`/api/writings/${piece._id}`).set(bearer(student.token)).send({ activeSeconds: 30 });
    expect(sameText.status).toBe(200);
    fakeOpenAi.flagged = false;

    expect((await api().get(`/api/writings/${piece._id}`).set(bearer(student.token))).body.writing.content).toBe("A fine sentence.");
    // Every save sends the text to the filter, and only the filter.
    const paths = fakeOpenAi.calls.map((c) => c.path);
    expect(paths).toContain("moderations");
    expect(paths).not.toContain("chat/completions");
  });

  it("stops paying ink drops after 10 rewarded pieces in a day, but keeps saving", async () => {
    const student = await signUp();
    for (let i = 0; i < 10; i++) await saveWriting(student.token, { type: "sentence", content: `Piece ${i}.` });
    const eleventh = await api().post("/api/writings").set(bearer(student.token)).send({ type: "essay", content: "One more." });
    expect(eleventh.status).toBe(201);
    expect(eleventh.body).toMatchObject({ inkDropsEarned: 0, rewardCapReached: true });
    expect(eleventh.body.user).toMatchObject({ inkDrops: 50, writingCount: 11 });
  });

  it("deleting a piece keeps the ink drops and lowers the piece count", async () => {
    const student = await signUp();
    const piece = await saveWriting(student.token, { type: "paragraph", content: "Gone soon." });
    const res = await api().delete(`/api/writings/${piece._id}`).set(bearer(student.token));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ inkDrops: 15, writingCount: 0 });
  });

  it("refuses empty writing and impossible writing times", async () => {
    const student = await signUp();
    expect((await api().post("/api/writings").set(bearer(student.token)).send({ type: "sentence", content: "   " })).status).toBe(400);
    const tooLong = await api()
      .post("/api/writings")
      .set(bearer(student.token))
      .send({ type: "sentence", content: "Hi.", activeSeconds: 7 * 60 * 60 });
    expect(tooLong.status).toBe(400);
  });

  it("lists only the student's own pieces, filtered by type", async () => {
    const student = await signUp();
    const other = await signUp();
    await saveWriting(student.token, { type: "sentence", content: "Mine one." });
    await saveWriting(student.token, { type: "paragraph", content: "Mine two." });
    await saveWriting(other.token, { type: "sentence", content: "Not mine." });

    const all = await api().get("/api/writings").set(bearer(student.token));
    expect(all.body.writings.map((w: { content: string }) => w.content).sort()).toEqual(["Mine one.", "Mine two."]);
    const sentences = await api().get("/api/writings?type=sentence").set(bearer(student.token));
    expect(sentences.body.writings).toHaveLength(1);
  });

  it("keeps one student out of another's writing", async () => {
    const owner = await signUp();
    const other = await signUp();
    const piece = await saveWriting(owner.token, { type: "sentence", content: "Private." });

    expect((await api().get(`/api/writings/${piece._id}`).set(bearer(other.token))).status).toBe(404);
    expect((await api().patch(`/api/writings/${piece._id}`).set(bearer(other.token)).send({ content: "Hacked." })).status).toBe(404);
    expect((await api().delete(`/api/writings/${piece._id}`).set(bearer(other.token))).status).toBe(404);
    expect((await api().get(`/api/writings/${piece._id}`).set(bearer(owner.token))).body.writing.content).toBe("Private.");
  });

  it("links the latest AI check to the saved piece, but never another student's check", async () => {
    const student = await signUp();
    const other = await signUp();

    fakeOpenAi.chatReplies.push(feedbackReply(), feedbackReply());
    const mine = await api().post("/api/ai/analyze").set(bearer(student.token)).send({ type: "paragraph", content: "I runned fast." });
    const theirs = await api().post("/api/ai/analyze").set(bearer(other.token)).send({ type: "paragraph", content: "Hi there." });

    const piece = await saveWriting(student.token, { type: "paragraph", content: "I ran fast.", feedbackRunId: mine.body.runId });
    expect(String((await FeedbackRun.findById(mine.body.runId).lean())!.writingId)).toBe(piece._id);

    await saveWriting(student.token, { type: "paragraph", content: "Another.", feedbackRunId: theirs.body.runId });
    expect((await FeedbackRun.findById(theirs.body.runId).lean())!.writingId).toBeNull();
  });
});
