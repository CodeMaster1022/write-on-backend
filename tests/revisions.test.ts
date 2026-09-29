import { beforeAll, describe, expect, it } from "vitest";
import { Revision } from "../src/models/Revision.js";
import { Writing } from "../src/models/Writing.js";
import { fakeOpenAi } from "./fake-network.js";
import {
  api,
  bearer,
  closeContest,
  createContest,
  feedbackReply,
  saveWriting,
  seedBasics,
  signUp,
  signUpAdmin,
} from "./helpers.js";

beforeAll(seedBasics);

const area = (rating: number) => ({ rating, praise: "Good.", issues: [] });
const versions = (token: string, id: string) => api().get(`/api/writings/${id}/revisions`).set(bearer(token));
const edit = (token: string, id: string, body: Record<string, unknown>) =>
  api().patch(`/api/writings/${id}`).set(bearer(token)).send(body);

async function check(token: string, content: string, grammar: number) {
  fakeOpenAi.chatReplies.push(feedbackReply({ grammar: area(grammar), evidence: area(2), flow: area(2) }));
  const res = await api().post("/api/ai/analyze").set(bearer(token)).send({ type: "paragraph", content });
  return res.body.runId as string;
}

describe("keeping versions", () => {
  it("keeps every saved version with the AI ratings made on it", async () => {
    const student = await signUp();
    const firstRun = await check(student.token, "The dog runned home.", 1);
    const piece = await saveWriting(student.token, { type: "paragraph", content: "The dog runned home.", feedbackRunId: firstRun });

    const secondRun = await check(student.token, "The dog ran home.", 3);
    const res = await edit(student.token, piece._id, { content: "The dog ran home.", feedbackRunId: secondRun, activeSeconds: 90 });
    expect(res.status).toBe(200);
    expect(res.body.versionCount).toBe(2);

    const list = await versions(student.token, piece._id);
    expect(list.body.revisions).toEqual([
      expect.objectContaining({ number: 1, content: "The dog runned home.", ratings: expect.objectContaining({ grammar: 1 }) }),
      expect.objectContaining({ number: 2, content: "The dog ran home.", ratings: expect.objectContaining({ grammar: 3 }) }),
    ]);
  });

  it("adds writing time from each revising session", async () => {
    const student = await signUp();
    const piece = await saveWriting(student.token, { type: "paragraph", content: "First try.", activeSeconds: 100 });
    await edit(student.token, piece._id, { content: "Second try.", activeSeconds: 50 });
    expect((await Writing.findById(piece._id).lean())!.activeSeconds).toBe(150);
  });

  it("doesn't make a new version when only the title changes", async () => {
    const student = await signUp();
    const piece = await saveWriting(student.token, { type: "paragraph", content: "Same words." });
    await edit(student.token, piece._id, { title: "A new title" });
    await edit(student.token, piece._id, { content: "Same words." });
    expect((await versions(student.token, piece._id)).body.revisions).toHaveLength(1);
  });

  it("attaches a check of the unchanged text to the latest version", async () => {
    const student = await signUp();
    const piece = await saveWriting(student.token, { type: "paragraph", content: "Cats nap." });
    const run = await check(student.token, "Cats nap.", 2);
    await edit(student.token, piece._id, { feedbackRunId: run });
    const list = await versions(student.token, piece._id);
    expect(list.body.revisions).toHaveLength(1);
    expect(list.body.revisions[0].ratings.grammar).toBe(2);
  });

  it("shows older pieces, saved before versions were kept, as version 1, and keeps that text on the first edit", async () => {
    const student = await signUp();
    const piece = await saveWriting(student.token, { type: "paragraph", content: "Old text." });
    await Revision.deleteMany({ writingId: piece._id });

    const before = await versions(student.token, piece._id);
    expect(before.body.revisions).toEqual([expect.objectContaining({ number: 1, content: "Old text." })]);

    await edit(student.token, piece._id, { content: "New text." });
    const after = await versions(student.token, piece._id);
    expect(after.body.revisions.map((r: { content: string }) => r.content)).toEqual(["Old text.", "New text."]);
  });

  it("shows how many versions each piece has in My writing", async () => {
    const student = await signUp();
    const piece = await saveWriting(student.token, { type: "paragraph", content: "One." });
    await edit(student.token, piece._id, { content: "Two." });
    const list = await api().get("/api/writings").set(bearer(student.token));
    expect(list.body.writings[0]).toMatchObject({ _id: piece._id, versionCount: 2 });
  });

  it("won't use another student's AI check", async () => {
    const student = await signUp();
    const other = await signUp();
    const piece = await saveWriting(student.token, { type: "paragraph", content: "Mine." });
    const theirRun = await check(other.token, "Theirs.", 3);
    await edit(student.token, piece._id, { content: "Mine, better.", feedbackRunId: theirRun });
    const list = await versions(student.token, piece._id);
    expect(list.body.revisions[1].ratings).toBeNull();
  });
});

describe("privacy and ownership", () => {
  it("keeps one student out of another's versions", async () => {
    const owner = await signUp();
    const other = await signUp();
    const piece = await saveWriting(owner.token, { type: "paragraph", content: "Private." });
    expect((await versions(other.token, piece._id)).status).toBe(404);
    expect((await versions(owner.token, "not-an-id")).status).toBe(404);
  });

  it("removes the versions when the piece is deleted", async () => {
    const student = await signUp();
    const piece = await saveWriting(student.token, { type: "paragraph", content: "One." });
    await edit(student.token, piece._id, { content: "Two." });
    await api().delete(`/api/writings/${piece._id}`).set(bearer(student.token));
    expect(await Revision.countDocuments({ writingId: piece._id })).toBe(0);
  });

  it("includes versions in Download my data and removes them with the account", async () => {
    const student = await signUp();
    const piece = await saveWriting(student.token, { type: "paragraph", content: "First draft." });
    await edit(student.token, piece._id, { content: "Second draft." });

    const exported = await api().get("/api/auth/me/export").set(bearer(student.token));
    expect(exported.body.writing[0].earlierVersions.map((v: { content: string }) => v.content)).toEqual([
      "First draft.",
      "Second draft.",
    ]);

    await api().delete("/api/auth/me").set(bearer(student.token)).send({ password: student.password });
    expect(await Revision.countDocuments({ userId: student.id })).toBe(0);
  });
});

describe("contest entries", () => {
  it("says which contest a piece was entered in, and whether it has closed", async () => {
    const admin = await signUpAdmin();
    const contestId = await createContest(admin.token);
    const student = await signUp();
    const piece = await saveWriting(student.token, { type: "paragraph", content: "Apple.", parts: { contestId } });
    await api().post(`/api/contests/${contestId}/enter`).set(bearer(student.token)).send({ writingId: piece._id });

    const open = await api().get(`/api/writings/${piece._id}`).set(bearer(student.token));
    expect(open.body.contest).toEqual({ id: contestId, title: "Apple Week", closed: false });

    await closeContest(admin.token, contestId);
    const closed = await api().get(`/api/writings/${piece._id}`).set(bearer(student.token));
    expect(closed.body.contest.closed).toBe(true);

    const res = await edit(student.token, piece._id, { content: "Changed." });
    expect(res.status).toBe(400);
    expect((await versions(student.token, piece._id)).body.revisions).toHaveLength(1);
  });

  it("returns no contest for an ordinary piece", async () => {
    const student = await signUp();
    const piece = await saveWriting(student.token, { type: "sentence", content: "Hi." });
    expect((await api().get(`/api/writings/${piece._id}`).set(bearer(student.token))).body.contest).toBeNull();
  });
});
