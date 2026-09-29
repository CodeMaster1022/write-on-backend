import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fakeOpenAi } from "./fake-network.js";
import { api, bearer, signUp } from "./helpers.js";

const savedFiles = () => {
  try {
    return readdirSync(process.env.TTS_CACHE_DIR!).length;
  } catch {
    return 0;
  }
};

describe("read aloud", () => {
  it("needs a signed-in account", async () => {
    expect((await api().post("/api/tts").send({ text: "Hello" })).status).toBe(401);
  });

  it("never saves audio of student writing", async () => {
    const student = await signUp();
    const before = savedFiles();

    const draft = await api().post("/api/tts").set(bearer(student.token)).send({ text: "My dog ran to the park.", keep: false });
    expect(draft.status).toBe(200);
    expect(draft.headers["content-type"]).toContain("audio/mpeg");
    expect(draft.headers["cache-control"]).toBe("no-store");

    await api().post("/api/tts").set(bearer(student.token)).send({ text: "An older app sends no flag." });
    await api()
      .post("/api/tts")
      .set(bearer(student.token))
      .send({ text: "A long draft sentence. ".repeat(40), keep: true });

    expect(savedFiles()).toBe(before);
  });

  it("saves and reuses the app's own short prompts", async () => {
    const student = await signUp();
    const before = savedFiles();
    const prompt = { text: "What is your opinion?", keep: true };

    await api().post("/api/tts").set(bearer(student.token)).send(prompt);
    expect(savedFiles()).toBe(before + 1);

    const again = await api().post("/api/tts").set(bearer(student.token)).send(prompt);
    expect(again.status).toBe(200);
    expect(fakeOpenAi.calls.filter((c) => c.path === "audio/speech")).toHaveLength(1);
  });
});
