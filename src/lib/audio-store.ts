import { createHash } from "node:crypto";
import { env } from "../config/env.js";

/**
 * A second, lasting home for the read-aloud audio of the app's own instructions (Cloudinary).
 * The server's disk is the fast first copy, but on Vercel it is wiped whenever the server
 * restarts, so without this every restart would pay to voice the same sentences again.
 *
 * Only the app's fixed instructions ever go here, and the file names are a hash of the
 * sentence. A student's writing, feedback and answers are never stored.
 */

interface Cloud {
  apiKey: string;
  apiSecret: string;
  cloudName: string;
}

const TIMEOUT_MS = 6000;
const FOLDER = "write-on/tts";

/** CLOUDINARY_URL looks like cloudinary://<api key>:<api secret>@<cloud name>. */
export function parseCloudinaryUrl(url: string | undefined): Cloud | null {
  const match = url?.trim().match(/^cloudinary:\/\/([^:@/]+):([^@/]+)@([^/?#]+)$/);
  return match ? { apiKey: match[1]!, apiSecret: match[2]!, cloudName: match[3]! } : null;
}

const cloud = () => parseCloudinaryUrl(env.CLOUDINARY_URL);

export const cloudStorageEnabled = () => cloud() !== null;

const publicId = (key: string) => `${FOLDER}/${key}`;

/** A saved copy, or null if there isn't one (or Cloudinary can't be reached). */
export async function getAudioFromCloud(key: string): Promise<Buffer | null> {
  const c = cloud();
  if (!c) return null;
  try {
    const res = await fetch(`https://res.cloudinary.com/${c.cloudName}/video/upload/${publicId(key)}.mp3`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** Saves a copy. Never throws: read-aloud still works if Cloudinary is down, it just costs a regeneration later. Says whether it worked. */
export async function saveAudioToCloud(key: string, audio: Buffer): Promise<boolean> {
  const c = cloud();
  if (!c) return false;

  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = publicId(key);
  // Cloudinary's signature: the signed fields sorted by name, joined, with the secret added and hashed.
  const signature = createHash("sha1").update(`public_id=${id}&timestamp=${timestamp}${c.apiSecret}`).digest("hex");

  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), `${key}.mp3`);
  form.set("public_id", id);
  form.set("timestamp", timestamp);
  form.set("api_key", c.apiKey);
  form.set("signature", signature);

  try {
    // Audio files are stored as Cloudinary's "video" type.
    const res = await fetch(`https://api.cloudinary.com/v1_1/${c.cloudName}/video/upload`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
    if (!res.ok) console.error("[audio-store] Cloudinary upload failed", res.status);
    return res.ok;
  } catch (err) {
    console.error("[audio-store] Cloudinary upload failed", err instanceof Error ? err.name : "error");
    return false;
  }
}
