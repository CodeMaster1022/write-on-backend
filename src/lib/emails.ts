import { escapeHtml } from "./email.js";

/** Plain, friendly emails. Each has a text version for mail apps that don't show HTML. */

const wrap = (inner: string) => `<!doctype html>
<html><body style="margin:0;background:#fbf6ec;font-family:Arial,Helvetica,sans-serif;color:#221d2e">
<div style="max-width:560px;margin:0 auto;padding:28px 24px">
<p style="font-size:22px;font-weight:bold;color:#5b4e8c;margin:0 0 20px">Write on!</p>
${inner}
<p style="font-size:13px;color:#6b6478;margin-top:32px">Write on! · Astra Voxis LLC</p>
</div></body></html>`;

export function passwordResetEmail(name: string, link: string) {
  const text = [
    `Hi ${name},`,
    "",
    "Someone asked to reset the password for this Write on! account. To choose a new password, open this link:",
    link,
    "",
    "The link works once and stops working after 1 hour.",
    "If you didn't ask for this, you can ignore this email. The password stays the same.",
  ].join("\n");

  const html = wrap(`
<p style="font-size:16px;line-height:1.5">Hi ${escapeHtml(name)},</p>
<p style="font-size:16px;line-height:1.5">Someone asked to reset the password for this Write on! account.</p>
<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#ff7a5c;color:#221d2e;font-weight:bold;text-decoration:none;padding:12px 24px;border-radius:999px;display:inline-block">Choose a new password</a></p>
<p style="font-size:14px;line-height:1.5;color:#5b5568">The link works once and stops working after 1 hour. If you didn't ask for this, you can ignore this email. The password stays the same.</p>`);

  return { subject: "Reset your Write on! password", text, html };
}

export function writingCopyEmail(piece: { studentName: string; type: string; title: string; content: string; date: string }) {
  const heading = piece.title || `A ${piece.type} by ${piece.studentName}`;
  const text = [`${heading}`, `Written by ${piece.studentName} on ${piece.date}`, "", piece.content, "", "Sent from Write on!"].join("\n");

  const html = wrap(`
<p style="font-size:14px;color:#5b5568;margin:0 0 6px">${escapeHtml(piece.studentName)} wrote this ${escapeHtml(piece.type)} on ${escapeHtml(piece.date)}.</p>
<h1 style="font-size:22px;margin:0 0 16px">${escapeHtml(heading)}</h1>
<div style="background:#ffffff;border:1px solid #ede3d4;border-radius:16px;padding:20px;font-size:17px;line-height:1.6;white-space:pre-wrap">${escapeHtml(piece.content)}</div>`);

  return { subject: `${piece.studentName}'s ${piece.type} from Write on!`, text, html };
}

export function verifyEmailEmail(name: string, link: string) {
  const text = [
    `Hi ${name},`,
    "",
    "Welcome to Write on! Please confirm this email address by opening this link:",
    link,
    "",
    "The link works for 2 days. If you didn't make a Write on! account, you can ignore this email.",
  ].join("\n");

  const html = wrap(`
<p style="font-size:16px;line-height:1.5">Hi ${escapeHtml(name)},</p>
<p style="font-size:16px;line-height:1.5">Welcome to Write on! Please confirm this email address.</p>
<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#ff7a5c;color:#221d2e;font-weight:bold;text-decoration:none;padding:12px 24px;border-radius:999px;display:inline-block">Confirm my email</a></p>
<p style="font-size:14px;line-height:1.5;color:#5b5568">The link works for 2 days. If you didn't make a Write on! account, you can ignore this email.</p>`);

  return { subject: "Confirm your email for Write on!", text, html };
}
