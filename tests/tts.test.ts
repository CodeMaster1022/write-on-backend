import { createHash } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseCloudinaryUrl } from "../src/lib/audio-store.js";
import { fakeCloud, fakeOpenAi } from "./fake-network.js";
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

describe("read-aloud for visitors who haven't signed in", () => {
  const speak = (text: string) => api().post("/api/tts/prompt").send({ text });

  it("voices the app's short instructions without signing in, and saves them for reuse", async () => {
    const before = savedFiles();
    const text = "Now, tell us why this proves your claim.";
    const first = await speak(text);
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toContain("audio/mpeg");
    expect(first.headers["cache-control"]).toContain("immutable");
    expect(savedFiles()).toBe(before + 1);

    const again = await speak(text);
    expect(again.status).toBe(200);
    expect(fakeOpenAi.calls.filter((c) => c.path === "audio/speech" && String(c.body.input) === text)).toHaveLength(1);
  });

  it("won't take anything as long as a draft", async () => {
    const before = savedFiles();
    const res = await speak("A long draft sentence. ".repeat(40));
    expect(res.status).toBe(400);
    expect((await speak("")).status).toBe(400);
    expect(savedFiles()).toBe(before);
    expect(fakeOpenAi.calls.filter((c) => c.path === "audio/speech")).toHaveLength(0);
  });

  it("doesn't open up the route that reads drafts and feedback", async () => {
    expect((await api().post("/api/tts").send({ text: "My private draft." })).status).toBe(401);
    expect(fakeOpenAi.calls.filter((c) => c.path === "audio/speech")).toHaveLength(0);
  });
});

describe("a lasting copy of the app's instructions (Cloudinary)", () => {
  const speak = (text: string) => api().post("/api/tts/prompt").send({ text });
  const speechCalls = (text: string) => fakeOpenAi.calls.filter((c) => c.path === "audio/speech" && String(c.body.input) === text).length;
  const emptyLocalDisk = () => {
    for (const f of readdirSync(process.env.TTS_CACHE_DIR!)) rmSync(`${process.env.TTS_CACHE_DIR}/${f}`);
  };

  it("uploads each new instruction once, named by a hash and signed, never with the text in the name", async () => {
    const text = "Tell us more about why that matters.";
    await speak(text);
    await speak(text);

    expect(fakeCloud.uploads).toHaveLength(1);
    const upload = fakeCloud.uploads[0]!;
    expect(upload.publicId).toMatch(/^write-on\/tts\/[a-f0-9]{64}$/);
    expect(upload.publicId).not.toContain("matters");
    expect(upload.apiKey).toBe("test-key");
    expect(upload.bytes).toBeGreaterThan(1000);
    // Cloudinary's rule: sha1 of the signed fields plus the secret. The secret itself is never sent.
    const expected = createHash("sha1").update(`public_id=${upload.publicId}&timestamp=${upload.timestamp}test-secret`).digest("hex");
    expect(upload.signature).toBe(expected);
    expect(JSON.stringify(upload)).not.toContain("test-secret");
  });

  it("never uploads a student's draft, feedback or long text", async () => {
    const student = await signUp();
    await api().post("/api/tts").set(bearer(student.token)).send({ text: "My private draft.", keep: false });
    await api().post("/api/tts").set(bearer(student.token)).send({ text: "A long draft sentence. ".repeat(40), keep: true });
    await api().post("/api/tts/prompt").send({ text: "A long draft sentence. ".repeat(40) });
    expect(fakeCloud.uploads).toHaveLength(0);
  });

  it("uploads what signed-in students hear too, when it is one of the app's fixed prompts", async () => {
    const student = await signUp();
    await api().post("/api/tts").set(bearer(student.token)).send({ text: "What is your opinion, really?", keep: true });
    expect(fakeCloud.uploads).toHaveLength(1);
  });

  it("serves it from Cloudinary after the server's disk has been wiped, without voicing it again", async () => {
    const text = "Now, tell us why this drives your point.";
    await speak(text);
    expect(speechCalls(text)).toBe(1);

    emptyLocalDisk();
    expect(savedFiles()).toBe(0);
    const again = await speak(text);
    expect(again.status).toBe(200);
    expect(again.body.length ?? again.text.length).toBeGreaterThan(0);
    expect(speechCalls(text)).toBe(1);
    expect(fakeCloud.uploads).toHaveLength(1);
    // The disk copy is back for the next request.
    expect(savedFiles()).toBe(1);
  });

  it("still reads aloud when Cloudinary is down", async () => {
    fakeCloud.down = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await speak("Where and when does it happen?");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/mpeg");
    expect(errors.mock.calls.flat().join(" ")).not.toContain("test-secret");
    errors.mockRestore();
  });

  it("reads the Cloudinary setting", () => {
    expect(parseCloudinaryUrl("cloudinary://123456:abc_DEF-9@my-cloud")).toEqual({ apiKey: "123456", apiSecret: "abc_DEF-9", cloudName: "my-cloud" });
    expect(parseCloudinaryUrl("  cloudinary://k:s@c  ")).toEqual({ apiKey: "k", apiSecret: "s", cloudName: "c" });
    for (const bad of [undefined, "", "https://x", "cloudinary://only-a-cloud", "cloudinary://k:s@", "cloudinary://k@c"]) {
      expect(parseCloudinaryUrl(bad)).toBeNull();
    }
  });
});
