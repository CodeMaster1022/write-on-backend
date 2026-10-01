import { Schema, model, type InferSchemaType } from "mongoose";

/** Erin asked for 3–5 practice steps; the limit leaves a little room. */
export const MAX_LESSON_STEPS = 6;
export const MAX_LESSON_CHOICES = 4;
/** Ink drops for finishing a lesson, awarded once per lesson. A sentence earns 5, a paragraph 15. */
export const LESSON_INK_DROPS = 10;

export const LESSON_STEP_KINDS = ["choice", "written"] as const;
export type LessonStepKind = (typeof LESSON_STEP_KINDS)[number];

const lessonStepSchema = new Schema(
  {
    question: { type: String, required: true, trim: true, maxlength: 300 },
    /** "choice": the student picks one answer. "written": the student types a short answer. */
    kind: { type: String, enum: LESSON_STEP_KINDS, required: true },
    /** Choice steps: 2–4 answers to pick from. Empty for written steps. */
    choices: { type: [{ type: String, trim: true, maxlength: 120 }], default: [] },
    /** Choice steps: index of the right answer in `choices`. Null for written steps. */
    answer: { type: Number, default: null },
    /** Written steps: an example answer shown as the box's placeholder. */
    example: { type: String, trim: true, maxlength: 300, default: "" },
  },
  { _id: false },
);

/**
 * A weekly mini-lesson Erin writes: a short teaching text, then a few
 * practice steps. The lesson with the latest start date that has already
 * started is "this week's lesson"; it stays up until the next one starts, so
 * a missed week never leaves students with nothing.
 */
const lessonSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 80 },
    /** The teaching part, in Erin's words. Shown above the practice. */
    teach: { type: String, required: true, trim: true, maxlength: 3000 },
    /** An optional example of the skill in use. */
    example: { type: String, trim: true, maxlength: 800, default: "" },
    startsAt: { type: Date, required: true, index: true },
    steps: { type: [lessonStepSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    /** When students were emailed that this lesson is up. Set the first time it's found started. */
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type LessonAttrs = InferSchemaType<typeof lessonSchema>;
export type LessonStep = LessonAttrs["steps"][number];
export const Lesson = model("Lesson", lessonSchema);

export type LessonStatus = "scheduled" | "current" | "past";

/** The lesson students see now: the latest one whose start date has passed. */
export async function currentLesson(now = new Date()) {
  return Lesson.findOne({ startsAt: { $lte: now } }).sort({ startsAt: -1 }).lean();
}

export function lessonStatus(
  lesson: { _id: unknown; startsAt: Date },
  current: { _id: unknown } | null,
  now = new Date(),
): LessonStatus {
  if (lesson.startsAt > now) return "scheduled";
  return current && String(current._id) === String(lesson._id) ? "current" : "past";
}

/** One student's finished practice. Doing a lesson again replaces the answers; the ink drops are only paid once. */
const lessonAttemptSchema = new Schema(
  {
    lessonId: { type: Schema.Types.ObjectId, ref: "Lesson", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    answers: {
      type: [
        new Schema(
          {
            /** Choice steps: the index the student picked. */
            choice: { type: Number, default: null },
            /** Written steps: what the student typed. */
            text: { type: String, trim: true, maxlength: 1000, default: "" },
            /** Choice steps: whether the pick was right. Null for written steps. */
            correct: { type: Boolean, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** Right answers out of the choice steps. */
    score: { type: Number, default: 0 },
    choiceCount: { type: Number, default: 0 },
    inkDropsAwarded: { type: Number, default: 0 },
    /** How many times the student has finished this lesson. */
    tries: { type: Number, default: 1 },
  },
  { timestamps: true },
);

lessonAttemptSchema.index({ lessonId: 1, userId: 1 }, { unique: true });
lessonAttemptSchema.index({ lessonId: 1, createdAt: 1 });

export type LessonAttemptAttrs = InferSchemaType<typeof lessonAttemptSchema>;
export const LessonAttempt = model("LessonAttempt", lessonAttemptSchema);
