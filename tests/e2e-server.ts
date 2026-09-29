/**
 * A throwaway API for the browser tests: in-memory database, fake OpenAI,
 * no internet, and two known accounts. Started by the client's Playwright
 * config with `npm run e2e-server`; stops when that process ends.
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import { blockedRequests, fakeFetch, fakeOpenAi } from "./fake-network.js";

const PORT = Number(process.env.E2E_API_PORT ?? 4210);
const mongo = await MongoMemoryServer.create();

// Must be set before the app is imported; these win over server/.env.
Object.assign(process.env, {
  NODE_ENV: "test",
  MONGODB_URI: `${mongo.getUri()}writeon-e2e`,
  JWT_SECRET: "e2e-secret-that-is-long-enough",
  CLIENT_ORIGIN: process.env.E2E_CLIENT_ORIGIN ?? "http://localhost:3210",
  OPENAI_API_KEY: "e2e-openai-key",
  DEEPGRAM_API_KEY: "",
  EMAIL_API_KEY: "",
  SENTRY_DSN: "",
});
globalThis.fetch = fakeFetch as typeof fetch;

/** Believable answers, so the pages have something real to show. */
fakeOpenAi.fallback = (schemaName, userMessage) => {
  switch (schemaName) {
    case "writing_feedback": {
      const hasMistake = userMessage.includes("runned");
      const area = (rating: number, issues: unknown[]) => ({ rating, praise: "You shared a clear idea.", issues });
      return {
        summary: hasMistake ? "Nice start! Let's fix one word." : "Great work, this reads clearly!",
        grammar: area(
          hasMistake ? 1 : 3,
          hasMistake ? [{ quote: "runned", suggestion: "Change 'runned' to 'ran'.", category: "verb_tense" }] : [],
        ),
        evidence: area(2, [{ quote: "", suggestion: "Add one example that shows your idea.", category: "needs_example" }]),
        flow: area(hasMistake ? 2 : 3, []),
      };
    }
    case "inki_define":
      return { suitable: true, definition: "A theme is the big idea of a story.", example: "The theme was friendship." };
    case "inki_check":
      return { verdict: "partly", answer: "Good start! Try adding the word 'first'." };
    case "progress_summary":
      return { overview: "Your student is writing often.", home: ["Read a story together."], classroom: ["Practise transition words."] };
    default:
      return {};
  }
};

const { connectDb } = await import("../src/config/db.js");
const { createApp } = await import("../src/app.js");
const { RewardItem } = await import("../src/models/RewardItem.js");
const { User, hashPassword } = await import("../src/models/User.js");
const { WordBankEntry } = await import("../src/models/WordBankEntry.js");

await connectDb();

await RewardItem.insertMany([
  { key: "hat-top", name: "Top Hat", slot: "hat", cost: 20, art: "topHat", color: "#FF7A5C", blurb: "For formal sentences.", sortOrder: 1 },
  { key: "held-pencil", name: "Glowing Pencil", slot: "held", cost: 15, art: "pencil", color: "#F2A13B", blurb: "Where every writer starts.", sortOrder: 1 },
  { key: "held-wand", name: "Word Wand", slot: "held", cost: 0, art: "wand", color: "#E4577E", blurb: "A contest prize.", sortOrder: 10, exclusive: true },
]);
await WordBankEntry.insertMany([
  { word: "shiny", partOfSpeech: "adjective", meaning: "bright", example: "A shiny coin.", tier: 1 },
  { word: "gloomy", partOfSpeech: "adjective", meaning: "dark and sad", example: "A gloomy day.", tier: 3 },
  { word: "swiftly", partOfSpeech: "adverb", meaning: "fast", example: "He ran swiftly.", tier: 1 },
  { word: "dog", partOfSpeech: "noun", category: "thing", meaning: "a pet", example: "The dog barked.", tier: 1 },
  { word: "ran", partOfSpeech: "verb", verbType: "action", meaning: "moved fast", example: "She ran.", tier: 1 },
]);
await User.create({
  displayName: "Erin",
  email: "admin@e2e.test",
  passwordHash: await hashPassword("AdminPass123!"),
  role: "student",
  isAdmin: true,
});

createApp().listen(PORT, () => console.log(`[e2e] API ready on http://localhost:${PORT}`));

// Anything the app tried to fetch from the real internet shows up in the test output.
setInterval(() => {
  if (blockedRequests.length) console.error("[e2e] blocked outside requests:", blockedRequests.splice(0));
}, 2000).unref();

const stop = async () => {
  await mongo.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
