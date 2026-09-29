import mongoose from "mongoose";
import { beforeAll, describe, expect, it } from "vitest";
import { Contest, ContestEntry } from "../src/models/Contest.js";
import { User } from "../src/models/User.js";
import { Writing } from "../src/models/Writing.js";
import {
  api,
  bearer,
  closeContest,
  createContest,
  saveWriting,
  seedBasics,
  signUp,
  signUpAdmin,
  type TestUser,
} from "./helpers.js";

const HOUR = 60 * 60 * 1000;
let admin: TestUser;

beforeAll(async () => {
  await seedBasics();
  admin = await signUpAdmin();
});

const enter = (token: string, contestId: string, writingId: string) =>
  api().post(`/api/contests/${contestId}/enter`).set(bearer(token)).send({ writingId });

const stepPiece = (token: string, contestId: string, type: "sentence" | "paragraph" | "essay" = "paragraph") =>
  saveWriting(token, { type, content: "My apple is red and shiny.", parts: { contestId, answers: ["red and shiny"] } });

describe("admin access", () => {
  it("keeps students out of every admin route", async () => {
    const student = await signUp();
    for (const [method, path] of [
      ["get", "/api/admin/contests"],
      ["get", "/api/admin/prizes"],
      ["post", "/api/admin/contests"],
    ] as const) {
      const res = await api()[method](path).set(bearer(student.token)).send({});
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("refuses a contest with no steps or a prize that isn't a contest prize", async () => {
    const base = {
      title: "T",
      prompt: "P",
      writingType: "paragraph",
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + HOUR).toISOString(),
    };
    const noSteps = await api().post("/api/admin/contests").set(bearer(admin.token)).send({ ...base, prizeKey: "held-wand", steps: [] });
    expect(noSteps.status).toBe(400);

    const shopItem = await api()
      .post("/api/admin/contests")
      .set(bearer(admin.token))
      .send({ ...base, prizeKey: "hat-top", steps: [{ question: "Q?" }] });
    expect(shopItem.status).toBe(400);
  });
});

describe("entering a contest", () => {
  it("gives the prize once, and a second entry swaps the piece", async () => {
    const contestId = await createContest(admin.token);
    const student = await signUp();

    const first = await enter(student.token, contestId, (await stepPiece(student.token, contestId))._id);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ prizeGranted: true, prize: { key: "held-wand" } });
    expect(first.body.user.ownedItems).toContain("held-wand");

    const secondPiece = await stepPiece(student.token, contestId);
    const second = await enter(student.token, contestId, secondPiece._id);
    expect(second.body.prizeGranted).toBe(false);

    const entries = await ContestEntry.find({ contestId }).lean();
    expect(entries).toHaveLength(1);
    expect(String(entries[0]!.writingId)).toBe(secondPiece._id);
    const user = await User.findById(student.id).lean();
    expect(user!.ownedItems.filter((k) => k === "held-wand")).toHaveLength(1);
  });

  it("refuses a regular piece for a contest with steps", async () => {
    const contestId = await createContest(admin.token);
    const student = await signUp();
    const regular = await saveWriting(student.token, { type: "paragraph", content: "A normal paragraph." });
    const res = await enter(student.token, contestId, regular._id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/steps/);
  });

  it("refuses the wrong writing type", async () => {
    const contestId = await createContest(admin.token);
    const student = await signUp();
    const sentence = await stepPiece(student.token, contestId, "sentence");
    const res = await enter(student.token, contestId, sentence._id);
    expect(res.status).toBe(400);
  });

  it("refuses entries before the start and after the end", async () => {
    const student = await signUp();

    const upcoming = await createContest(admin.token, { startsAt: new Date(Date.now() + HOUR), endsAt: new Date(Date.now() + 2 * HOUR) });
    const early = await enter(student.token, upcoming, (await stepPiece(student.token, upcoming))._id);
    expect(early.status).toBe(400);
    expect(early.body.error).toMatch(/hasn't started/);

    const closed = await createContest(admin.token);
    const piece = await stepPiece(student.token, closed);
    await closeContest(admin.token, closed);
    const late = await enter(student.token, closed, piece._id);
    expect(late.status).toBe(400);
    expect(late.body.error).toMatch(/closed/);
  });

  it("won't enter another student's writing", async () => {
    const contestId = await createContest(admin.token);
    const owner = await signUp();
    const other = await signUp();
    const piece = await stepPiece(owner.token, contestId);
    expect((await enter(other.token, contestId, piece._id)).status).toBe(404);
  });
});

describe("contests made before steps existed", () => {
  async function oldContest() {
    // Written straight to the database without a steps field, like the real older contests.
    const now = Date.now();
    const { insertedId } = await Contest.collection.insertOne({
      title: "Old Contest",
      prompt: "Write anything.",
      writingType: "paragraph",
      startsAt: new Date(now - HOUR),
      endsAt: new Date(now + HOUR),
      prizeKey: "held-wand",
      announcedAt: null,
      createdBy: admin.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return String(insertedId);
  }

  it("still load on the student and admin contest lists", async () => {
    const id = await oldContest();
    const student = await signUp();

    const list = await api().get("/api/contests").set(bearer(student.token));
    expect(list.status).toBe(200);
    expect(list.body.contests.find((c: { id: string }) => c.id === id)).toMatchObject({ stepCount: 0 });

    const adminList = await api().get("/api/admin/contests").set(bearer(admin.token));
    expect(adminList.status).toBe(200);
    expect(adminList.body.contests.find((c: { id: string }) => c.id === id)).toMatchObject({ steps: [] });

    const detail = await api().get(`/api/contests/${id}`).set(bearer(student.token));
    expect(detail.body.contest.steps).toEqual([]);
  });

  it("accept a regular piece written after the start, but not one written before", async () => {
    const id = await oldContest();
    const student = await signUp();
    const fresh = await saveWriting(student.token, { type: "paragraph", content: "Written today." });
    expect((await enter(student.token, id, fresh._id)).status).toBe(200);

    const old = await saveWriting(student.token, { type: "paragraph", content: "Written long ago." });
    await Writing.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(old._id) },
      { $set: { createdAt: new Date(Date.now() - 3 * HOUR) } },
    );
    const res = await enter(student.token, id, old._id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/after the contest starts/);
  });
});

describe("judging and winners", () => {
  const markWinner = (contestId: string, entryId: string, isWinner = true) =>
    api().post(`/api/admin/contests/${contestId}/entries/${entryId}/winner`).set(bearer(admin.token)).send({ isWinner });

  it("picks winners only after the contest closes, and hides them until they are announced", async () => {
    const contestId = await createContest(admin.token);
    const student = await signUp();
    await enter(student.token, contestId, (await stepPiece(student.token, contestId))._id);

    const entries = await api().get(`/api/admin/contests/${contestId}/entries`).set(bearer(admin.token));
    expect(entries.body.entries[0]).toMatchObject({ student: "Sam", writing: { content: "My apple is red and shiny." } });
    const entryId = entries.body.entries[0].id;

    const whileOpen = await markWinner(contestId, entryId);
    expect(whileOpen.status).toBe(400);
    const earlyAnnounce = await api().post(`/api/admin/contests/${contestId}/announce`).set(bearer(admin.token));
    expect(earlyAnnounce.status).toBe(400);

    await closeContest(admin.token, contestId);
    expect((await markWinner(contestId, entryId)).status).toBe(200);

    const hidden = await api().get("/api/contests").set(bearer(student.token));
    const card = hidden.body.contests.find((c: { id: string }) => c.id === contestId);
    expect(card.myEntry.isWinner).toBeNull();
    expect(card.winnerCount).toBeNull();
    expect((await api().get("/api/contests/wins").set(bearer(student.token))).body.wins).toEqual([]);

    const announced = await api().post(`/api/admin/contests/${contestId}/announce`).set(bearer(admin.token));
    expect(announced.body).toMatchObject({ ok: true, winners: 1 });

    const afterAnnounce = await markWinner(contestId, entryId, false);
    expect(afterAnnounce.status).toBe(400);

    const shown = await api().get("/api/contests").set(bearer(student.token));
    expect(shown.body.contests.find((c: { id: string }) => c.id === contestId).myEntry.isWinner).toBe(true);

    const wins = await api().get("/api/contests/wins").set(bearer(student.token));
    expect(wins.body.wins).toEqual([expect.objectContaining({ contestId, seen: false })]);
    await api().post(`/api/contests/wins/${wins.body.wins[0].entryId}/seen`).set(bearer(student.token));
    const seen = await api().get("/api/contests/wins").set(bearer(student.token));
    expect(seen.body.wins[0].seen).toBe(true);
  });

  it("won't announce a closed contest with no winner picked", async () => {
    const contestId = await createContest(admin.token);
    await closeContest(admin.token, contestId);
    const res = await api().post(`/api/admin/contests/${contestId}/announce`).set(bearer(admin.token));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/winner/);
  });
});

describe("contest entries after the contest closes", () => {
  it("can be edited while open, but not after closing; other pieces stay editable", async () => {
    const contestId = await createContest(admin.token);
    const student = await signUp();
    const entry = await stepPiece(student.token, contestId);
    const other = await saveWriting(student.token, { type: "sentence", content: "Free sentence." });
    await enter(student.token, contestId, entry._id);

    const whileOpen = await api().patch(`/api/writings/${entry._id}`).set(bearer(student.token)).send({ content: "My big apple." });
    expect(whileOpen.status).toBe(200);

    await closeContest(admin.token, contestId);
    const afterClose = await api().patch(`/api/writings/${entry._id}`).set(bearer(student.token)).send({ content: "Changed later." });
    expect(afterClose.status).toBe(400);
    expect((await Writing.findById(entry._id).lean())!.content).toBe("My big apple.");

    const otherEdit = await api().patch(`/api/writings/${other._id}`).set(bearer(student.token)).send({ content: "Edited sentence." });
    expect(otherEdit.status).toBe(200);
  });
});

describe("contest prizes in the closet", () => {
  it("can't be bought with ink drops", async () => {
    const student = await signUp();
    await User.updateOne({ _id: student.id }, { inkDrops: 500 });
    const res = await api().post("/api/rewards/unlock").set(bearer(student.token)).send({ key: "held-wand" });
    expect(res.status).toBe(403);
  });
});

describe("deleting a contest", () => {
  it("removes its entries, and the student keeps the prize and the writing", async () => {
    const contestId = await createContest(admin.token);
    const student = await signUp();
    const piece = await stepPiece(student.token, contestId);
    await enter(student.token, contestId, piece._id);

    const res = await api().delete(`/api/admin/contests/${contestId}`).set(bearer(admin.token));
    expect(res.body).toMatchObject({ ok: true, entriesRemoved: 1 });
    expect(await ContestEntry.countDocuments({ contestId })).toBe(0);
    expect((await User.findById(student.id).lean())!.ownedItems).toContain("held-wand");
    expect(await Writing.exists({ _id: piece._id })).toBeTruthy();

    const again = await api().delete(`/api/admin/contests/${contestId}`).set(bearer(admin.token));
    expect(again.status).toBe(404);
  });
});
