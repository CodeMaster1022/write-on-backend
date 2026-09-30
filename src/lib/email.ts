import { env } from "../config/env.js";
import { HttpError } from "../middleware/error.js";

interface Attachment {
  filename: string;
  content: Buffer;
}

/** Sends one email through Resend (https://resend.com/docs/api-reference/emails/send-email). */
export async function sendEmail(msg: {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Attachment[];
  /** Shown to the person if sending fails. */
  failMessage?: string;
}): Promise<void> {
  if (!env.EMAIL_API_KEY) {
    throw new HttpError(503, "Email isn't set up yet. Add EMAIL_API_KEY to the server .env file.");
  }

  const failMessage = msg.failMessage ?? "Couldn't send that email right now. Please try again, or download the report instead.";

  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.EMAIL_API_KEY}` },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content.toString("base64") })),
      }),
    });
  } catch {
    throw new HttpError(502, failMessage);
  }

  if (!res.ok) {
    console.error("[email] Resend request failed", res.status, await res.text().catch(() => ""));
    throw new HttpError(502, failMessage);
  }
}

/** The website address for links in emails, without a trailing slash. */
export function appUrl(): string {
  return (env.APP_URL ?? env.CLIENT_ORIGIN.split(",")[0]!.trim()).replace(/\/+$/, "");
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]!);
}
