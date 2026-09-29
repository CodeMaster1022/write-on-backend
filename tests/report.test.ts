import { beforeAll, describe, expect, it } from "vitest";
import { ReportShare } from "../src/models/ReportShare.js";
import { fakeOpenAi } from "./fake-network.js";
import { api, bearer, saveWriting, seedBasics, signUp } from "./helpers.js";

beforeAll(seedBasics);

const summaryReply = { overview: "Your student is writing often.", home: ["Read together."], classroom: ["Practise transitions."] };

describe("progress report", () => {
  it("adds up time, pieces and repeated questions", async () => {
    const student = await signUp({ displayName: "Lena" });
    await saveWriting(student.token, { type: "paragraph", content: "One two three.", activeSeconds: 120 });
    await saveWriting(student.token, { type: "paragraph", content: "Four five.", activeSeconds: 180 });
    for (let i = 0; i < 2; i++) {
      await api().post("/api/events/help").set(bearer(student.token)).send({ kind: "word_help", topic: "noun" });
    }

    fakeOpenAi.chatReplies.push(summaryReply);
    const res = await api().get("/api/report/me?days=30").set(bearer(student.token));
    expect(res.status).toBe(200);
    const { report } = res.body;
    expect(report.time.totalMinutes).toBe(5);
    expect(report.activity.totalPieces).toBe(2);
    expect(report.activity.totalWords).toBe(5);
    expect(report.questions.items).toEqual([expect.objectContaining({ count: 2 })]);
  });

  it("writes the summary from numbers only, never the name or the writing", async () => {
    const student = await signUp({ displayName: "Lena" });
    await saveWriting(student.token, { type: "paragraph", content: "My secret pancake story.", activeSeconds: 60 });

    fakeOpenAi.chatReplies.push(summaryReply);
    await api().get("/api/report/me?days=7").set(bearer(student.token));

    const sent = JSON.stringify(fakeOpenAi.chatCalls()[0]!.body.messages);
    expect(sent).not.toContain("Lena");
    expect(sent).not.toContain("pancake");
    expect(sent).not.toContain(student.email);
  });

  it("only accepts 7, 30 or 90 days", async () => {
    const student = await signUp();
    expect((await api().get("/api/report/me?days=14").set(bearer(student.token))).status).toBe(400);
  });
});

describe("report share links", () => {
  it("open without signing in, and stop working once turned off", async () => {
    const student = await signUp({ displayName: "Lena" });
    const created = await api().post("/api/report/shares").set(bearer(student.token)).send({ days: 30 });
    expect(created.status).toBe(201);
    const { id, token } = created.body;

    const stored = await ReportShare.findById(id).lean();
    expect(JSON.stringify(stored)).not.toContain(token);

    const shared = await api().get(`/api/report/shared/${token}`);
    expect(shared.status).toBe(200);
    expect(shared.body.report.student.displayName).toBe("Lena");
    expect(shared.headers["cache-control"]).toBe("no-store");
    expect(shared.headers["x-robots-tag"]).toContain("noindex");

    expect((await api().delete(`/api/report/shares/${id}`).set(bearer(student.token))).status).toBe(204);
    expect((await api().get(`/api/report/shared/${token}`)).status).toBe(404);
  });

  it("can't be turned off by another student", async () => {
    const owner = await signUp();
    const other = await signUp();
    const { id, token } = (await api().post("/api/report/shares").set(bearer(owner.token)).send({ days: 7 })).body;
    expect((await api().delete(`/api/report/shares/${id}`).set(bearer(other.token))).status).toBe(404);
    expect((await api().get(`/api/report/shared/${token}`)).status).toBe(200);
  });

  it("stop working after they expire", async () => {
    const student = await signUp();
    const { id, token } = (await api().post("/api/report/shares").set(bearer(student.token)).send({ days: 7 })).body;
    await ReportShare.updateOne({ _id: id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await api().get(`/api/report/shared/${token}`)).status).toBe(404);
  });

  it("refuse made-up links", async () => {
    expect((await api().get("/api/report/shared/not-a-real-link")).status).toBe(404);
    expect((await api().get(`/api/report/shared/${"a".repeat(32)}`)).status).toBe(404);
  });
});

describe("emailing a report", () => {
  it("explains that email isn't set up yet", async () => {
    const student = await signUp();
    const res = await api().post("/api/report/email").set(bearer(student.token)).send({ to: "parent@test.com", days: 7 });
    expect(res.status).toBe(503);
  });
});
