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

/** Sent to the parent or guardian a student named at sign-up. Nothing works until they approve. */
export function parentApprovalEmail(student: { name: string; email: string; grade: string | null }, links: { approve: string; decline: string; policy: string }) {
  const grade = student.grade ? (student.grade === "K" ? "kindergarten" : `grade ${student.grade}`) : "no grade given";
  const text = [
    "Hello,",
    "",
    `${student.name} (${grade}) just created a Write on! account using ${student.email} and gave this address as their parent's or guardian's.`,
    "",
    "Write on! is a writing practice app for kindergarten to 8th grade. It saves the student's writing, gives AI feedback on it, and can read instructions aloud. Our privacy policy explains what we save and who can see it:",
    links.policy,
    "",
    "The account is paused until you approve it. To approve, open this link:",
    links.approve,
    "",
    "If you didn't expect this, or you'd rather not, open this link and we'll delete the account and everything in it:",
    links.decline,
    "",
    "The links work for 7 days. You can withdraw approval at any time from the Account page, or by replying to this email.",
  ].join("\n");

  const html = wrap(`
<p style="font-size:16px;line-height:1.5">Hello,</p>
<p style="font-size:16px;line-height:1.5"><strong>${escapeHtml(student.name)}</strong> (${escapeHtml(grade)}) just created a Write on! account using ${escapeHtml(student.email)} and gave this address as their parent's or guardian's.</p>
<p style="font-size:16px;line-height:1.5">Write on! is a writing practice app for kindergarten to 8th grade. It saves the student's writing, gives AI feedback on it, and can read instructions aloud. <a href="${escapeHtml(links.policy)}" style="color:#5b4e8c">Our privacy policy</a> explains what we save and who can see it.</p>
<p style="font-size:16px;line-height:1.5">The account is paused until you approve it.</p>
<p style="margin:24px 0"><a href="${escapeHtml(links.approve)}" style="background:#ff7a5c;color:#221d2e;font-weight:bold;text-decoration:none;padding:12px 24px;border-radius:999px;display:inline-block">Yes, approve this account</a></p>
<p style="font-size:14px;line-height:1.5;color:#5b5568">If you didn't expect this, or you'd rather not, <a href="${escapeHtml(links.decline)}" style="color:#b23e22">delete the account</a> and everything in it instead.</p>
<p style="font-size:14px;line-height:1.5;color:#5b5568">The links work for 7 days. You can withdraw approval at any time from the Account page, or by replying to this email.</p>`);

  return { subject: `Please approve ${student.name}'s Write on! account`, text, html };
}

const button = (link: string, label: string) =>
  `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#ff7a5c;color:#221d2e;font-weight:bold;text-decoration:none;padding:12px 24px;border-radius:999px;display:inline-block">${escapeHtml(label)}</a></p>`;

const unsubscribeNote = "You get this because you have a Write on! account. To stop these emails, turn them off on your Account page.";

/** To every entrant once Erin announces the winners. Nobody else's name is mentioned. */
export function contestResultsEmail(name: string, contest: { title: string; prizeName: string | null }, won: boolean, link: string) {
  const text = won
    ? [
        `Hi ${name},`,
        "",
        `Great news: your entry won in ${contest.title}! Open Write on! to see your winner badge${contest.prizeName ? ` next to your ${contest.prizeName}` : ""}.`,
        link,
      ].join("\n")
    : [
        `Hi ${name},`,
        "",
        `The winners of ${contest.title} have been announced. Thank you for entering: every entry was read, and your writing counts.${contest.prizeName ? ` Your ${contest.prizeName} is still in your closet.` : ""}`,
        "Keep writing. There's always a next contest!",
        link,
      ].join("\n");

  const html = wrap(`
<p style="font-size:16px;line-height:1.5">Hi ${escapeHtml(name)},</p>
<p style="font-size:16px;line-height:1.5">${
    won
      ? `Great news: your entry <strong>won</strong> in ${escapeHtml(contest.title)}! Open Write on! to see your winner badge${contest.prizeName ? ` next to your ${escapeHtml(contest.prizeName)}` : ""}.`
      : `The winners of <strong>${escapeHtml(contest.title)}</strong> have been announced. Thank you for entering: every entry was read, and your writing counts.${contest.prizeName ? ` Your ${escapeHtml(contest.prizeName)} is still in your closet.` : ""} Keep writing. There's always a next contest!`
  }</p>
${button(link, won ? "See my badge" : "Open Write on!")}`);

  return { subject: won ? `You won ${contest.title}!` : `The winners of ${contest.title} are announced`, text, html };
}

/** To every student when a new weekly lesson goes up. */
export function newLessonEmail(name: string, lesson: { title: string }, link: string) {
  const text = [
    `Hi ${name},`,
    "",
    `This week's lesson is up: ${lesson.title}. It's a quick read and a short practice, and finishing it earns ink drops.`,
    link,
    "",
    unsubscribeNote,
  ].join("\n");

  const html = wrap(`
<p style="font-size:16px;line-height:1.5">Hi ${escapeHtml(name)},</p>
<p style="font-size:16px;line-height:1.5">This week's lesson is up: <strong>${escapeHtml(lesson.title)}</strong>. It's a quick read and a short practice, and finishing it earns ink drops.</p>
${button(link, "Do this week's lesson")}
<p style="font-size:13px;line-height:1.5;color:#6b6478">${escapeHtml(unsubscribeNote)}</p>`);

  return { subject: `New lesson: ${lesson.title}`, text, html };
}

/** To each admin, at most once a day, while something on the overview needs attention. */
export function adminDigestEmail(name: string, items: string[], link: string) {
  const text = [`Hi ${name},`, "", "Write on! has a few things waiting for you:", "", ...items.map((i) => `- ${i}`), "", link].join("\n");

  const html = wrap(`
<p style="font-size:16px;line-height:1.5">Hi ${escapeHtml(name)},</p>
<p style="font-size:16px;line-height:1.5">Write on! has a few things waiting for you:</p>
<ul style="font-size:16px;line-height:1.6">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>
${button(link, "Open the admin page")}`);

  return { subject: `Write on! needs you: ${items.length === 1 ? "1 thing" : `${items.length} things`} to look at`, text, html };
}

/** To the parent when a student taps "Ask a parent", or a parent asks for the link from the Account page. */
export function upgradeLinkEmail(student: { name: string }, prices: { monthly: string; yearly: string }, link: string) {
  const text = [
    "Hello,",
    "",
    `${student.name} would like Write on! Premium: AI feedback on every piece, Inki's help any time, voice typing, and the written progress report.`,
    `It's ${prices.monthly} or ${prices.yearly} for the whole family, and you can cancel any time. Paying happens on Stripe's secure page, never inside the app.`,
    "",
    "To upgrade, or to manage a plan you already have, open this link:",
    link,
    "",
    "The link works for 7 days. If you didn't expect this, you can ignore it.",
  ].join("\n");

  const html = wrap(`
<p style="font-size:16px;line-height:1.5">Hello,</p>
<p style="font-size:16px;line-height:1.5"><strong>${escapeHtml(student.name)}</strong> would like Write on! Premium: AI feedback on every piece, Inki's help any time, voice typing, and the written progress report.</p>
<p style="font-size:16px;line-height:1.5">It's ${escapeHtml(prices.monthly)} or ${escapeHtml(prices.yearly)} for the whole family, and you can cancel any time. Paying happens on Stripe's secure page, never inside the app.</p>
${button(link, "See Premium")}
<p style="font-size:14px;line-height:1.5;color:#5b5568">The link works for 7 days. If you didn't expect this, you can ignore it.</p>`);

  return { subject: `${student.name} would like Write on! Premium`, text, html };
}

/** To the parent when Stripe couldn't take a payment. Premium stays on for a week while it retries. */
export function paymentFailedEmail(link: string, graceDays: number) {
  const text = [
    "Hello,",
    "",
    "We couldn't take this month's payment for Write on! Premium. That usually means a card has expired or was declined.",
    `Nothing changes for ${graceDays} days, and the payment will be tried again. To update the card, open this link:`,
    link,
    "",
    `If it still can't go through after ${graceDays} days, the family goes back to the free plan. Nothing is deleted.`,
  ].join("\n");

  const html = wrap(`
<p style="font-size:16px;line-height:1.5">Hello,</p>
<p style="font-size:16px;line-height:1.5">We couldn't take this month's payment for Write on! Premium. That usually means a card has expired or was declined.</p>
<p style="font-size:16px;line-height:1.5">Nothing changes for ${graceDays} days, and the payment will be tried again.</p>
${button(link, "Update my card")}
<p style="font-size:14px;line-height:1.5;color:#5b5568">If it still can't go through after ${graceDays} days, the family goes back to the free plan. Nothing is deleted.</p>`);

  return { subject: "Write on! Premium: we couldn't take the payment", text, html };
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
