import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { TYPE_LABEL, type Report, type Trend } from "./report.js";

// ---------------------------------------------------------------------------
// Shared wording, so the web page, Word file, and email all say the same thing
// ---------------------------------------------------------------------------

function fmtDate(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: tz });
}

export function ratingText(avg: number | null): string {
  if (avg === null) return "Not checked yet";
  if (avg >= 2.5) return "Strong";
  if (avg >= 1.75) return "On the right track";
  return "Needs practice";
}

export function trendText(trend: Trend | null): string {
  if (trend === "improving") return "Improving";
  if (trend === "slipping") return "Needs attention lately";
  if (trend === "steady") return "Steady";
  return "";
}

const times = (n: number) => (n === 1 ? "once" : `${n} times`);

function minutesText(n: number): string {
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export interface ReportSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  table?: { head: string[]; rows: string[][] };
}

export interface ReportDocument {
  title: string;
  subtitle: string;
  sections: ReportSection[];
  footer: string;
}

/** The report as plain sections. The web page, Word file, and email are all rendered from this. */
export function reportDocument(report: Report, tz: string): ReportDocument {
  const { student, period, time, activity, questions, focus, summary } = report;
  const out: ReportSection[] = [];

  if (summary) {
    out.push({ heading: "Summary", paragraphs: [summary.overview] });
    out.push({ heading: "Ideas for home", bullets: summary.home });
    out.push({ heading: "Ideas for the classroom", bullets: summary.classroom });
  }

  const avgLines = Object.entries(time.avgMinutesByType).map(
    ([type, mins]) => `${TYPE_LABEL[type as keyof typeof TYPE_LABEL]}: about ${mins} min each`,
  );
  out.push({
    heading: "Time spent writing",
    paragraphs: [
      time.timedPieces > 0
        ? `${minutesText(time.totalMinutes)} of active writing time. Only time spent actively working counts; idle time is left out.`
        : "No timed writing yet in this period.",
    ],
    bullets: avgLines,
    table:
      time.weekly.length > 0
        ? {
            head: ["Week of", "Pieces", "Time"],
            rows: time.weekly.map((w) => [fmtDate(`${w.weekStart}T12:00:00Z`, "UTC"), String(w.pieces), minutesText(w.minutes)]),
          }
        : undefined,
  });

  out.push({
    heading: "Writing activity",
    paragraphs: [`${activity.totalPieces} ${activity.totalPieces === 1 ? "piece" : "pieces"} finished, ${activity.totalWords} words in total.`],
    bullets: activity.byType
      .filter((t) => t.pieces > 0)
      .map((t) => `${t.label}: ${t.pieces} (about ${t.avgWords} words each)`),
    table:
      activity.recent.length > 0
        ? {
            head: ["Recent piece", "Type", "Date", "Words", "Time"],
            rows: activity.recent.map((r) => [
              r.title,
              TYPE_LABEL[r.type].replace(/s$/, ""),
              fmtDate(r.date, tz),
              String(r.words),
              r.minutes === null ? "—" : minutesText(r.minutes),
            ]),
          }
        : undefined,
  });

  const repeated = questions.items.filter((q) => q.count > 1);
  out.push({
    heading: "Questions asked more than once",
    paragraphs: [
      repeated.length > 0
        ? "Topics the student asked Inki about or used a help button for more than once. These are good topics to review together."
        : "No repeated questions in this period.",
    ],
    bullets: repeated.map((q) => `${q.label} — ${times(q.count)}`),
  });

  const focusParagraphs: string[] = [];
  if (focus.analyses === 0) {
    focusParagraphs.push("The student hasn't used AI feedback in this period yet, so there's no feedback pattern to show.");
  } else {
    focusParagraphs.push(
      `Based on ${focus.analyses} AI feedback ${focus.analyses === 1 ? "check" : "checks"} of the student's drafts.`,
    );
  }
  out.push({
    heading: "Areas to focus on",
    paragraphs: focusParagraphs,
    table:
      focus.analyses > 0
        ? {
            head: ["Area", "How it's going", "Lately"],
            rows: focus.areas.filter((a) => a.avgRating !== null).map((a) => [a.label, ratingText(a.avgRating), trendText(a.trend) || "—"]),
          }
        : undefined,
  });

  const patterns = [
    ...focus.topIssues.map((i) => `${i.label}: flagged ${times(i.count)}`),
    ...focus.inkiChecks.map((c) => `${c.label}: checked with Inki ${times(c.total)}, "not yet" ${times(c.notYet)}`),
  ];
  if (patterns.length > 0) out.push({ heading: "What came up most", bullets: patterns });

  return {
    title: "Write on! Progress Report",
    subtitle: `${student.displayName}${student.grade ? ` · ${student.grade}` : ""} · ${fmtDate(period.from, tz)} – ${fmtDate(period.to, tz)} (last ${period.days} days)`,
    sections: out,
    footer: `Made with Write on! · Generated ${fmtDate(report.generatedAt, tz)}`,
  };
}

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------

const BORDER = { style: BorderStyle.SINGLE, size: 4, color: "D9CFBF" };

function docxTable(head: string[], rows: string[][]): Table {
  const cell = (text: string, bold = false) =>
    new TableCell({
      borders: { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ children: [new TextRun({ text, bold })] })],
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: head.map((h) => cell(h, true)) }),
      ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) })),
    ],
  });
}

export async function reportDocx(report: Report, tz: string): Promise<Buffer> {
  const doc = reportDocument(report, tz);
  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(doc.title)] }),
    new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: doc.subtitle, color: "5B5568" })] }),
  ];

  for (const s of doc.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240 }, children: [new TextRun(s.heading)] }));
    for (const p of s.paragraphs ?? []) children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun(p)] }));
    for (const b of s.bullets ?? []) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(b)] }));
    if (s.table && s.table.rows.length > 0) {
      children.push(docxTable(s.table.head, s.table.rows));
      children.push(new Paragraph({ children: [] }));
    }
  }

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 360 },
      children: [new TextRun({ text: doc.footer, size: 18, color: "7D7689" })],
    }),
  );

  return Packer.toBuffer(new Document({ creator: "Write on!", title: doc.title, sections: [{ children }] }));
}

// ---------------------------------------------------------------------------
// Email (plain text + HTML)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function reportEmail(report: Report, tz: string): { subject: string; text: string; html: string } {
  const doc = reportDocument(report, tz);

  const text = [
    doc.title,
    doc.subtitle,
    "",
    ...doc.sections.flatMap((s) => [
      s.heading.toUpperCase(),
      ...(s.paragraphs ?? []),
      ...(s.bullets ?? []).map((b) => `• ${b}`),
      ...(s.table && s.table.rows.length > 0 ? [s.table.head.join(" | "), ...s.table.rows.map((r) => r.join(" | "))] : []),
      "",
    ]),
    "The attached Word file can be edited, or opened in Google Docs by uploading it to Google Drive.",
    doc.footer,
  ].join("\n");

  const td = "padding:6px 10px;border:1px solid #ede3d4;text-align:left;";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#221d2e;max-width:640px;line-height:1.5">
<h1 style="color:#3e3462;margin-bottom:4px">${escapeHtml(doc.title)}</h1>
<p style="color:#5b5568;margin-top:0">${escapeHtml(doc.subtitle)}</p>
${doc.sections
  .map(
    (s) => `<h2 style="color:#3e3462;font-size:18px;margin:24px 0 8px">${escapeHtml(s.heading)}</h2>
${(s.paragraphs ?? []).map((p) => `<p style="margin:0 0 8px">${escapeHtml(p)}</p>`).join("")}
${s.bullets && s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>` : ""}
${
  s.table && s.table.rows.length
    ? `<table style="border-collapse:collapse;width:100%;font-size:14px"><tr>${s.table.head
        .map((h) => `<th style="${td}background:#fbf6ec">${escapeHtml(h)}</th>`)
        .join("")}</tr>${s.table.rows
        .map((r) => `<tr>${r.map((c) => `<td style="${td}">${escapeHtml(c)}</td>`).join("")}</tr>`)
        .join("")}</table>`
    : ""
}`,
  )
  .join("\n")}
<p style="margin-top:24px">The attached Word file can be edited, or opened in Google Docs by uploading it to Google Drive.</p>
<p style="color:#7d7689;font-size:12px;margin-top:24px">${escapeHtml(doc.footer)}</p>
</div>`;

  return { subject: `Write on! progress report for ${report.student.displayName}`, text, html };
}
