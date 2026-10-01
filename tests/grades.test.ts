import { beforeAll, describe, expect, it } from "vitest";
import { gradeBand, inkiDailyLimit, wordTiersFor } from "../src/config/grades.js";
import { User } from "../src/models/User.js";
import { WordBankEntry } from "../src/models/WordBankEntry.js";
import { fakeOpenAi } from "./fake-network.js";
import { api, bearer, feedbackReply, seedBasics, signUp } from "./helpers.js";

beforeAll(async () => {
  await seedBasics();
  for (const [word, tier] of [
    ["shiny", 1],
    ["brave", 1],
    ["curious", 2],
    ["gloomy", 3],
    ["ancient", 3],
  ] as const) {
    await WordBankEntry.updateOne(
      { word, partOfSpeech: "adjective" },
      { $set: { word, partOfSpeech: "adjective", meaning: "m", example: "e", tier } },
      { upsert: true },
    );
  }
});

describe("grade bands", () => {
  it.each([
    ["K", "youngest"],
    ["2", "youngest"],
    ["3", "middle"],
    ["5", "middle"],
    ["6", "oldest"],
    ["8", "oldest"],
    ["2nd grade", "youngest"],
  ])("grade %s is in the %s band", (grade, band) => {
    expect(gradeBand(grade)).toBe(band);
  });

  it("is a K–8 app: grades above 8th aren't offered and read as no grade", async () => {
    expect(gradeBand("9")).toBeNull();
    expect(gradeBand("12")).toBeNull();
    const res = await api()
      .post("/api/auth/register")
      .send({ displayName: "Teen", email: "teen@test.com", password: "Password123!", gradeLevel: "10" });
    expect(res.status).toBe(400);
  });

  it("has no band, and today's behaviour, without a grade", () => {
    expect(gradeBand(null)).toBeNull();
    expect(inkiDailyLimit(null)).toBe(10);
    expect(wordTiersFor(null)).toEqual([1, 2, 3]);
  });
});

describe("AI feedback by grade", () => {
  const threeIssues = {
    rating: 1,
    praise: "Good try.",
    issues: [
      { quote: "", suggestion: "Add a capital letter.", category: "capitalization" },
      { quote: "", suggestion: "Add a period.", category: "punctuation" },
      { quote: "", suggestion: "Check the spelling.", category: "spelling" },
    ],
  };

  async function analyze(grade: string | null) {
    const student = await signUp({ gradeLevel: grade ?? "4" });
    if (grade === null) await User.updateOne({ _id: student.id }, { $unset: { gradeLevel: 1 } });
    fakeOpenAi.chatReplies.push(feedbackReply({ grammar: threeIssues }));
    const res = await api().post("/api/ai/analyze").set(bearer(student.token)).send({ type: "paragraph", content: "the dog ran" });
    const system = fakeOpenAi.chatCalls().at(-1)!.body.messages!.find((m) => m.role === "system")!.content;
    return { res, system };
  }

  it("asks for short, basic feedback for K–2, and keeps only the most important tip", async () => {
    const { res, system } = await analyze("1");
    expect(system).toContain("kindergarten to 2nd grade");
    expect(res.body.feedback.grammar.issues).toHaveLength(1);
    expect(res.body.feedback.grammar.issues[0].suggestion).toBe("Add a capital letter.");
  });

  it("sets 3rd–5th grade expectations and keeps up to 3 tips", async () => {
    const { res, system } = await analyze("4");
    expect(system).toContain("3rd to 5th grade");
    expect(res.body.feedback.grammar.issues).toHaveLength(3);
  });

  it("expects more from 6th to 8th grade, without asking for a high-school essay voice", async () => {
    const { system } = await analyze("8");
    expect(system).toContain("6th to 8th grade");
    expect(system).toContain("not high school");
    expect(system).not.toContain("formal school tone");
  });

  it("uses the base instructions when there's no grade", async () => {
    const { res, system } = await analyze(null);
    expect(system).not.toMatch(/kindergarten to 2nd|3rd to 5th|6th to 8th grade/);
    expect(res.body.feedback.grammar.issues).toHaveLength(3);
  });

  it("keeps sentence feedback to grammar for every grade", async () => {
    const student = await signUp({ gradeLevel: "7" });
    fakeOpenAi.chatReplies.push(feedbackReply());
    const res = await api().post("/api/ai/analyze").set(bearer(student.token)).send({ type: "sentence", content: "The dog ran." });
    const system = fakeOpenAi.chatCalls()[0]!.body.messages![0]!.content;
    expect(system).toContain("6th to 8th grade");
    expect(system).toContain("single sentence");
    expect(res.body.feedback.evidence).toBeNull();
  });
});

describe("word ideas by grade", () => {
  const adjectives = async (grade?: string) => {
    const res = await api().get(`/api/wordbank?partOfSpeech=adjective${grade ? `&grade=${encodeURIComponent(grade)}` : ""}`);
    return res.body.words.map((w: { word: string }) => w.word);
  };

  it("leaves out the hardest words for K–2", async () => {
    expect(await adjectives("1")).toEqual(["brave", "shiny", "curious"]);
  });

  it("keeps the original easiest-first list for 3–5 and for no grade", async () => {
    const list = ["brave", "shiny", "curious", "ancient", "gloomy"];
    expect(await adjectives("4")).toEqual(list);
    expect(await adjectives()).toEqual(list);
  });

  it("shows the hardest words first for 6th grade and up", async () => {
    expect(await adjectives("7")).toEqual(["ancient", "gloomy", "curious", "brave", "shiny"]);
  });

  it("ignores a grade it doesn't recognise instead of failing", async () => {
    const res = await api().get("/api/wordbank?partOfSpeech=adjective&grade=banana");
    expect(res.status).toBe(200);
    expect(res.body.words[0].word).toBe("brave");
  });

  it("applies to the grouped lists too", async () => {
    const res = await api().get("/api/wordbank/grouped?grade=K");
    expect(res.body.grouped.adjective.map((w: { word: string }) => w.word)).not.toContain("gloomy");
  });
});
