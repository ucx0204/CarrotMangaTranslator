import { z } from "zod";
import { finiteNumber, uuid } from "./ipcSchemaPrimitives";

const PageTimingSessionRefSchema = z
  .object({
    id: uuid,
    startedAtEpochMs: finiteNumber.min(0),
  })
  .strict();

export const FinishPageTimingSessionRequestSchema = z
  .object({
    chapterId: uuid,
    sessionId: uuid,
    elapsedMs: finiteNumber.min(0),
    state: z.enum(["interrupted", "completed"]),
  })
  .strict();

export const PageTimingSessionFields = {
  timingSession: PageTimingSessionRefSchema.optional(),
};
