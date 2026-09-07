import { z } from "zod";

export const letteringToolSchema = z
  .object({
    blockId: z.string().max(200).nullable(),
    space: z.enum(["asset", "page"]),
    mode: z.enum(["hide", "restore"]),
    shape: z.enum(["circle", "square"]),
    size: z.number().finite().min(1).max(400),
    softness: z.number().finite().min(0).max(1),
    showMask: z.boolean(),
  })
  .strict();
const point = z
  .object({
    x: z.number().finite().min(-10000).max(10000),
    y: z.number().finite().min(-10000).max(10000),
  })
  .strict();
export const letteringMaskStrokesSchema = z
  .array(
    z
      .object({
        space: z.enum(["asset", "page"]),
        mode: z.enum(["hide", "restore"]),
        shape: z.enum(["circle", "square"]),
        radiusX: z.number().finite().positive().max(100000),
        radiusY: z.number().finite().positive().max(100000),
        softness: z.number().finite().min(0).max(1),
        points: z.array(point).min(1).max(2048),
      })
      .strict(),
  )
  .max(500);
export const letteringOcclusionSchema = z
  .array(z.array(point).min(3).max(128))
  .max(64);
