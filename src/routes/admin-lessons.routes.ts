import { Router } from "express";
import { z } from "zod";
import { normalizeGrade } from "../config/grades.js";
import { logAdminAction } from "../lib/audit.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import {
  LESSON_INK_DROPS,
  LESSON_STEP_KINDS,
  Lesson,
  LessonAttempt,
  MAX_LESSON_CHOICES,
  MAX_LESSON_STEPS,
  currentLesson,
  lessonStatus,
  type LessonStep,
} from "../models/Lesson.js";
import { User } from "../models/User.js";

export const adminLessonsRouter = Router();

adminLessonsRouter.use(requireAuth, requireAdmin);

const objectId = z.string().regex(/^[a-f0-9]{24}$/);

async function requireLesson(raw: unknown) {
  const parsed = objectId.safeParse(raw);
  const lesson = parsed.success ? await Lesson.findById(parsed.data) : null;
  if (!lesson) throw new HttpError(404, "We couldn't find that lesson.");
  return lesson;
}

const stepSchema = z
  .object({
    question: z.string().trim().min(1, "Every step needs a question.").max(300),
    kind: z.enum(LESSON_STEP_KINDS),
    choices: z.array(z.string().trim().min(1, "Every answer choice needs some text.").max(120)).max(MAX_LESSON_CHOICES).default([]),
    answer: z.number().int().min(0).nullable().default(null),
    example: z.string().trim().max(300).default(""),
  })
  .superRefine((s, ctx) => {
    if (s.kind === "choice") {
      if (s.choices.length < 2) ctx.addIssue({ code: "custom", path: ["choices"], message: "A pick-an-answer step needs at least 2 choices." });
      if (s.answer === null || s.answer >= s.choices.length) ctx.addIssue({ code: "custom", path: ["answer"], message: "Mark which choice is the right answer." });
    }
  })
  // Written steps don't keep stray choices from before the kind was switched.
  .transform((s) => (s.kind === "written" ? { ...s, choices: [], answer: null } : { ...s, example: "" }));

const lessonFields = z.object({
  title: z.string().trim().min(1, "Give the lesson a title.").max(80),
  teach: z.string().trim().min(1, "Write what this lesson teaches.").max(3000),
  example: z.string().trim().max(800).default(""),
  startsAt: z.coerce.date(),
  steps: z
    .array(stepSchema)
    .min(1, "Add at least one practice step.")
    .max(MAX_LESSON_STEPS, `A lesson can have up to ${MAX_LESSON_STEPS} steps.`),
});

function stepsChanged(current: LessonStep[], next: z.infer<typeof lessonFields>["steps"]): boolean {
  if (current.length !== next.length) return true;
  return current.some((s, i) => {
    const n = next[i]!;
    return (
      s.question !== n.question ||
      s.kind !== n.kind ||
      (s.answer ?? null) !== n.answer ||
      (s.example ?? "") !== n.example ||
      s.choices.length !== n.choices.length ||
      s.choices.some((c, j) => c !== n.choices[j])
    );
  });
}

function toJson(l: { _id: unknown; title: string; teach: string; example?: string | null; startsAt: Date; steps: LessonStep[] }) {
  return {
    id: String(l._id),
    title: l.title,
    teach: l.teach,
    example: l.example ?? "",
    startsAt: l.startsAt,
    inkDrops: LESSON_INK_DROPS,
    steps: l.steps.map((s) => ({ question: s.question, kind: s.kind, choices: [...s.choices], answer: s.answer ?? null, example: s.example ?? "" })),
  };
}

adminLessonsRouter.get("/lessons", async (_req, res) => {
  const [lessons, current, counts] = await Promise.all([
    Lesson.find().sort({ startsAt: -1 }).limit(200).lean(),
    currentLesson(),
    LessonAttempt.aggregate<{ _id: unknown; n: number }>([{ $group: { _id: "$lessonId", n: { $sum: 1 } } }]),
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json({
    lessons: lessons.map((l) => ({ ...toJson(l), status: lessonStatus(l, current), finishedCount: byId.get(String(l._id)) ?? 0 })),
  });
});

adminLessonsRouter.post("/lessons", async (req, res) => {
  const body = lessonFields.parse(req.body);
  const lesson = await Lesson.create({ ...body, createdBy: req.user!._id });
  await logAdminAction(req.user!._id, "lesson_create", { lessonTitle: lesson.title });
  res.status(201).json({ id: lesson.id as string });
});

adminLessonsRouter.patch("/lessons/:id", async (req, res) => {
  const lesson = await requireLesson(req.params.id);
  const body = lessonFields.partial().parse(req.body);

  // Students answered the steps as they stood; changing them would make their results meaningless.
  const finished = (await LessonAttempt.countDocuments({ lessonId: lesson._id })) > 0;
  if (finished && body.steps !== undefined && stepsChanged(lesson.steps, body.steps)) {
    throw new HttpError(400, "Students have already done this practice, so the steps can't change.");
  }

  lesson.set(body);
  await lesson.save();
  await logAdminAction(req.user!._id, "lesson_update", { lessonTitle: lesson.title });
  res.json({ ok: true });
});

/** Removes a lesson and students' practice results. Students keep the ink drops they earned. */
adminLessonsRouter.delete("/lessons/:id", async (req, res) => {
  const lesson = await requireLesson(req.params.id);
  const { deletedCount } = await LessonAttempt.deleteMany({ lessonId: lesson._id });
  await lesson.deleteOne();
  await logAdminAction(req.user!._id, "lesson_delete", {
    lessonTitle: lesson.title,
    note: `${deletedCount} ${deletedCount === 1 ? "result" : "results"} removed`,
  });
  res.json({ ok: true, resultsRemoved: deletedCount });
});

const MAX_WRITTEN_SHOWN = 200;

/** How students did: a count per choice for pick-an-answer steps, and the answers themselves for written steps. */
adminLessonsRouter.get("/lessons/:id/results", async (req, res) => {
  const lesson = await requireLesson(req.params.id);
  const attempts = await LessonAttempt.find({ lessonId: lesson._id }).sort({ createdAt: 1 }).limit(5000).lean();
  const users = await User.find({ _id: { $in: attempts.map((a) => a.userId) } }).select("displayName gradeLevel").lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));

  const steps = lesson.steps.map((step, i) => {
    if (step.kind === "choice") {
      const picks = step.choices.map(() => 0);
      for (const a of attempts) {
        const c = a.answers[i]?.choice;
        if (typeof c === "number" && c < picks.length) picks[c]! += 1;
      }
      return { question: step.question, kind: "choice" as const, choices: step.choices, answer: step.answer, picks };
    }
    const written = attempts.slice(0, MAX_WRITTEN_SHOWN).map((a) => {
      const u = userById.get(String(a.userId));
      return { student: u?.displayName ?? "Unknown writer", grade: normalizeGrade(u?.gradeLevel), text: a.answers[i]?.text ?? "" };
    });
    return { question: step.question, kind: "written" as const, written };
  });

  const choiceTotal = lesson.steps.filter((s) => s.kind === "choice").length;
  const scoreSum = attempts.reduce((sum, a) => sum + a.score, 0);

  res.json({
    finished: attempts.length,
    averageScore: attempts.length && choiceTotal ? Math.round((scoreSum / attempts.length) * 10) / 10 : null,
    choiceTotal,
    steps,
  });
});
