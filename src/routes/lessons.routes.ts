import { Router } from "express";
import { z } from "zod";
import { requireSchoolSafe } from "../lib/moderation.js";
import { notifyLessonIfDue } from "../lib/notify.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { LESSON_INK_DROPS, Lesson, LessonAttempt, currentLesson, lessonStatus, type LessonStep } from "../models/Lesson.js";
import { publicUser } from "../models/User.js";

export const lessonsRouter = Router();

lessonsRouter.use(requireAuth);

const PAST_LESSONS = 12;
const objectId = z.string().regex(/^[a-f0-9]{24}$/);

function idParam(raw: unknown): string {
  const parsed = objectId.safeParse(raw);
  if (!parsed.success) throw new HttpError(404, "We couldn't find that lesson.");
  return parsed.data;
}

function mine(attempt: { score: number; choiceCount: number; tries: number; updatedAt: Date } | null | undefined) {
  if (!attempt) return null;
  return { score: attempt.score, choiceCount: attempt.choiceCount, tries: attempt.tries, finishedAt: attempt.updatedAt };
}

/** This week's lesson and the ones before it, with whether this student has finished each. */
lessonsRouter.get("/", async (req, res) => {
  const now = new Date();
  const current = await currentLesson(now);
  // The first visit after a lesson starts also tells everyone about it (the daily job does the same, in case nobody visits).
  void notifyLessonIfDue().catch((err) => console.error("[notify] new lesson", err instanceof Error ? err.message : err));
  const past = current
    ? await Lesson.find({ startsAt: { $lte: now }, _id: { $ne: current._id } }).sort({ startsAt: -1 }).limit(PAST_LESSONS).select("title startsAt steps").lean()
    : [];
  const all = current ? [current, ...past] : past;

  const attempts = await LessonAttempt.find({ userId: req.user!._id, lessonId: { $in: all.map((l) => l._id) } }).lean();
  const byLesson = new Map(attempts.map((a) => [String(a.lessonId), a]));

  const summary = (l: { _id: unknown; title: string; startsAt: Date; steps: unknown[] }) => ({
    id: String(l._id),
    title: l.title,
    startsAt: l.startsAt,
    stepCount: l.steps.length,
    inkDrops: LESSON_INK_DROPS,
    mine: mine(byLesson.get(String(l._id))),
  });

  res.json({ current: current ? summary(current) : null, past: past.map(summary) });
});

/** One lesson with its practice steps. The right answers stay on the server until the student finishes. */
lessonsRouter.get("/:id", async (req, res) => {
  const lesson = await Lesson.findById(idParam(req.params.id)).lean();
  // A lesson that hasn't started yet is Erin's draft; students can't see it.
  if (!lesson || lesson.startsAt > new Date()) throw new HttpError(404, "We couldn't find that lesson.");

  const [attempt, current] = await Promise.all([
    LessonAttempt.findOne({ lessonId: lesson._id, userId: req.user!._id }).lean(),
    currentLesson(),
  ]);

  res.json({
    lesson: {
      id: String(lesson._id),
      title: lesson.title,
      teach: lesson.teach,
      example: lesson.example ?? "",
      startsAt: lesson.startsAt,
      status: lessonStatus(lesson, current),
      inkDrops: LESSON_INK_DROPS,
      steps: lesson.steps.map((s) => ({
        question: s.question,
        kind: s.kind,
        choices: s.kind === "choice" ? s.choices : [],
        example: s.kind === "written" ? (s.example ?? "") : "",
      })),
      mine: mine(attempt),
    },
  });
});

const answerSchema = z.union([z.number().int().min(0), z.string().trim().max(1000)]);
const completeSchema = z.object({ answers: z.array(answerSchema).max(20) });

function checkAnswers(steps: LessonStep[], answers: (number | string)[]) {
  if (answers.length !== steps.length) throw new HttpError(400, "Please answer every step first.");
  return steps.map((step, i) => {
    const given = answers[i]!;
    if (step.kind === "choice") {
      if (typeof given !== "number" || given >= step.choices.length) throw new HttpError(400, `Pick an answer for step ${i + 1}.`);
      return { choice: given, text: "", correct: given === step.answer, correctChoice: step.answer };
    }
    if (typeof given !== "string" || given.length === 0) throw new HttpError(400, `Write an answer for step ${i + 1}.`);
    return { choice: null, text: given, correct: null, correctChoice: null };
  });
}

/** Finishes the practice. The ink drops are paid the first time only; trying again just updates the answers. */
lessonsRouter.post("/:id/complete", async (req, res) => {
  const lesson = await Lesson.findById(idParam(req.params.id)).lean();
  if (!lesson || lesson.startsAt > new Date()) throw new HttpError(404, "We couldn't find that lesson.");
  if (lesson.steps.length === 0) throw new HttpError(400, "This lesson has no practice steps yet.");

  const { answers } = completeSchema.parse(req.body);
  const user = req.user!;
  const results = checkAnswers(lesson.steps, answers);
  // Erin reads the written answers, so they go through the same safety filter as saved writing.
  await requireSchoolSafe(results.map((r) => r.text));
  const choiceCount = results.filter((r) => r.correct !== null).length;
  const score = results.filter((r) => r.correct === true).length;

  const answersToSave = results.map(({ choice, text, correct }) => ({ choice, text, correct }));
  const previous = await LessonAttempt.findOne({ lessonId: lesson._id, userId: user._id });
  const inkDropsEarned = previous ? 0 : LESSON_INK_DROPS;

  if (previous) {
    await LessonAttempt.updateOne({ _id: previous._id }, { $set: { answers: answersToSave, score, choiceCount }, $inc: { tries: 1 } });
  } else {
    await LessonAttempt.create({ lessonId: lesson._id, userId: user._id, answers: answersToSave, score, choiceCount, inkDropsAwarded: inkDropsEarned });
  }

  if (inkDropsEarned > 0) {
    user.inkDrops += inkDropsEarned;
    await user.save();
  }

  res.json({
    results: results.map(({ correct, correctChoice }) => ({ correct, correctChoice })),
    score,
    choiceCount,
    inkDropsEarned,
    user: publicUser(user),
  });
});
