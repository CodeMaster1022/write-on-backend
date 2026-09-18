import { Router } from "express";
import { z } from "zod";
import { User } from "../models/User.js";
import { Writing } from "../models/Writing.js";
import { requireAuth, requireTeacher } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";

export const teacherRouter = Router();

teacherRouter.use(requireAuth, requireTeacher);

/** Roster for the teacher's class code, with a light activity summary. */
teacherRouter.get("/students", async (req, res) => {
  const teacher = req.user!;
  if (!teacher.classCode) {
    throw new HttpError(400, "Add a class code to your account to start a roster.");
  }

  const students = await User.find({
    role: "student",
    classCode: teacher.classCode,
  })
    .select("displayName gradeLevel writingCount lastWroteAt inkDrops")
    .sort({ displayName: 1 })
    .lean();

  res.json({ classCode: teacher.classCode, students });
});

const paramsSchema = z.object({ id: z.string().trim().min(1) });

teacherRouter.get("/students/:id/writings", async (req, res) => {
  const { id } = paramsSchema.parse(req.params);
  const teacher = req.user!;

  const student = await User.findOne({ _id: id, role: "student", classCode: teacher.classCode });
  if (!student) throw new HttpError(404, "That student isn't in your class.");

  const writings = await Writing.find({ userId: student._id }).sort({ createdAt: -1 }).limit(50).lean();

  res.json({
    student: {
      id: student.id,
      displayName: student.displayName,
      gradeLevel: student.gradeLevel ?? null,
      writingCount: student.writingCount,
    },
    writings,
  });
});
