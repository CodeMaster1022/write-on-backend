/**
 * Stands in for every outside service during tests. OpenAI answers come from
 * a queue each test fills; any other outside request is refused and recorded,
 * so a test fails if the app tries to reach the real internet.
 */
export interface OpenAiCall {
  path: string;
  body: { messages?: { role: string; content: string }[]; input?: unknown } & Record<string, unknown>;
}

export const fakeOpenAi = {
  /** Next structured replies for chat completions, used in order. */
  chatReplies: [] as unknown[],
  /** What the safety filter says about every text it checks. */
  flagged: false,
  calls: [] as OpenAiCall[],
  /** Answers by response type when nothing is queued (used by the browser-test server). */
  fallback: null as ((schemaName: string, userMessage: string) => unknown) | null,
  reset() {
    this.chatReplies = [];
    this.flagged = false;
    this.calls = [];
  },
  chatCalls() {
    return this.calls.filter((c) => c.path === "chat/completions");
  },
};

export const blockedRequests: string[] = [];

export interface SentEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: string }[];
}

/** Emails the app handed to Resend, newest last. */
export const fakeResend = {
  sent: [] as SentEmail[],
  failNext: false,
  reset() {
    this.sent = [];
    this.failNext = false;
  },
};

export interface CloudUpload {
  publicId: string;
  apiKey: string;
  timestamp: string;
  signature: string;
  bytes: number;
}

/** A pretend Cloudinary account named "test-cloud", holding audio by its public id. */
export const fakeCloud = {
  files: new Map<string, Buffer>(),
  uploads: [] as CloudUpload[],
  /** Every request to Cloudinary fails, as if it were down. */
  down: false,
  reset() {
    this.files.clear();
    this.uploads = [];
    this.down = false;
  },
};

const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

export async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  if (url.startsWith("https://api.openai.com/v1/")) {
    const path = url.slice("https://api.openai.com/v1/".length);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    fakeOpenAi.calls.push({ path, body });

    if (path === "moderations") {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return json({ results: inputs.map(() => ({ flagged: fakeOpenAi.flagged })) });
    }
    if (path === "chat/completions") {
      const schemaName = body.response_format?.json_schema?.name ?? "";
      const userMessage = body.messages?.find((m: { role: string }) => m.role === "user")?.content ?? "";
      if (fakeOpenAi.chatReplies.length === 0 && !fakeOpenAi.fallback) return new Response("no fake reply queued", { status: 500 });
      const reply = fakeOpenAi.chatReplies.length > 0 ? fakeOpenAi.chatReplies.shift() : fakeOpenAi.fallback!(schemaName, userMessage);
      return json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
    }
    if (path === "audio/speech") {
      return new Response(new Uint8Array(2048).fill(7), { headers: { "Content-Type": "audio/mpeg" } });
    }
  }

  if (url.startsWith("https://api.cloudinary.com/v1_1/test-cloud/video/upload")) {
    if (fakeCloud.down) return new Response("down", { status: 503 });
    const form = init?.body as FormData;
    const file = form.get("file") as Blob;
    const bytes = Buffer.from(await file.arrayBuffer());
    const publicId = String(form.get("public_id"));
    fakeCloud.files.set(publicId, bytes);
    fakeCloud.uploads.push({
      publicId,
      apiKey: String(form.get("api_key")),
      timestamp: String(form.get("timestamp")),
      signature: String(form.get("signature")),
      bytes: bytes.length,
    });
    return json({ public_id: publicId });
  }

  if (url.startsWith("https://res.cloudinary.com/test-cloud/video/upload/")) {
    if (fakeCloud.down) return new Response("down", { status: 503 });
    const publicId = url.slice("https://res.cloudinary.com/test-cloud/video/upload/".length).replace(/\.mp3$/, "");
    const file = fakeCloud.files.get(publicId);
    return file ? new Response(new Uint8Array(file), { headers: { "Content-Type": "audio/mpeg" } }) : new Response("not found", { status: 404 });
  }

  if (url === "https://api.resend.com/emails") {
    if (fakeResend.failNext) {
      fakeResend.failNext = false;
      return new Response("{\"message\":\"fake failure\"}", { status: 500 });
    }
    fakeResend.sent.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
    return json({ id: `email-${fakeResend.sent.length}` });
  }

  blockedRequests.push(url);
  throw new Error(`Tests must not reach the internet: ${url}`);
}
