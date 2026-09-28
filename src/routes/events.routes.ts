import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { HELP_KINDS, HelpEvent } from "../models/HelpEvent.js";
import { WRITING_TYPES } from "../models/Writing.js";

export const eventsRouter = Router();

eventsRouter.use(requireAuth);

const helpSchema = z.object({
  kind: z.enum(HELP_KINDS),
  topic: z.string().trim().min(1).max(60),
  writingType: z.enum(WRITING_TYPES).optional(),
});

/** Records a help-button or word-lookup use, for the progress report's "repeated questions". */
eventsRouter.post("/help", async (req, res) => {
  const body = helpSchema.parse(req.body);

  await HelpEvent.create({
    userId: req.user!._id,
    kind: body.kind,
    topic: body.topic,
    writingType: body.writingType ?? null,
  });

  res.status(204).send();
});
