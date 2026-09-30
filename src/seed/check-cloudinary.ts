/**
 * Checks the Cloudinary connection with your real account:
 *   npm run check-cloudinary
 * It voices one short test sentence (a few cents at most), uploads it, reads it back, and says what it found.
 * The test file is named "self-test-…" so it can be told apart from the app's audio and deleted in Cloudinary.
 */
import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { cloudStorageEnabled, getAudioFromCloud, saveAudioToCloud } from "../lib/audio-store.js";

const say = (ok: boolean, message: string) => console.log(`${ok ? "OK  " : "FAIL"}  ${message}`);

if (!cloudStorageEnabled()) {
  say(false, "CLOUDINARY_URL isn't set in server/.env. It looks like cloudinary://<api key>:<api secret>@<cloud name> (Cloudinary dashboard → Settings → API keys).");
  process.exit(1);
}
say(true, "CLOUDINARY_URL is set and in the right format");

if (!env.OPENAI_API_KEY) {
  say(false, "OPENAI_API_KEY isn't set, so there is no test audio to upload.");
  process.exit(1);
}

const speech = await fetch("https://api.openai.com/v1/audio/speech", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
  body: JSON.stringify({ model: env.OPENAI_TTS_MODEL, voice: env.OPENAI_TTS_VOICE, input: "Write on! connection test.", response_format: "mp3" }),
});
if (!speech.ok) {
  say(false, `Couldn't make test audio (OpenAI said ${speech.status}).`);
  process.exit(1);
}
const audio = Buffer.from(await speech.arrayBuffer());
say(true, `Made ${audio.length} bytes of test audio`);

const key = `self-test-${randomBytes(6).toString("hex")}`;
const saved = await saveAudioToCloud(key, audio);
say(saved, saved ? `Uploaded write-on/tts/${key}` : "The upload was refused. Check the API key and secret, and that the cloud name is right.");
if (!saved) process.exit(1);

const back = await getAudioFromCloud(key);
say(back !== null && back.length > 0, back ? `Read it back (${back.length} bytes)` : "Couldn't read the file back. In Cloudinary, check Settings → Security that public delivery of audio and video isn't restricted.");
if (!back) process.exit(1);

console.log(`\nAll good. You can delete the test file "write-on/tts/${key}" in the Cloudinary media library.`);
