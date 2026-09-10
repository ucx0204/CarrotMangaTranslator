import { z } from "zod";

const point = z
  .object({
    x: z.number().finite().min(0).max(200000),
    y: z.number().finite().min(0).max(200000),
  })
  .strict();
export const imageRedactionStrokeSchema = z
  .object({
    shape: z.enum(["rectangle", "round", "square"]),
    operation: z.enum(["hide", "restore"]).optional(),
    size: z.number().finite().min(1).max(4000),
    points: z.array(point).min(1).max(20000),
  })
  .strict();
export type ImageRedactionStroke = z.infer<typeof imageRedactionStrokeSchema>;
export type ImageRedactionPage = {
  id: string;
  name: string;
  imagePath: string;
  width: number;
  height: number;
  fingerprint: string;
  strokes: ImageRedactionStroke[];
};
export type ImageRedactionReview = {
  sessionId: string;
  pages: ImageRedactionPage[];
};
export const confirmImageRedactionSchema = z
  .object({
    jobId: z.string().uuid(),
    sessionId: z.string().uuid(),
    workspaceRevision: z.number().int().nonnegative().optional(),
    pages: z
      .array(
        z
          .object({
            id: z.string().min(1).max(500),
            fingerprint: z.string().length(64),
            strokes: z.array(imageRedactionStrokeSchema).max(1000),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export type ConfirmImageRedaction = z.infer<typeof confirmImageRedactionSchema>;

export const imageRedactionReviewSchema = z
  .object({
    sessionId: z.string().uuid(),
    pages: z
      .array(
        z
          .object({
            id: z.string().min(1).max(500),
            name: z.string().max(2000),
            imagePath: z.string().min(1).max(32768),
            width: z.number().int().positive().max(200000),
            height: z.number().int().positive().max(200000),
            fingerprint: z.string().length(64),
            strokes: z.array(imageRedactionStrokeSchema).max(1000),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();

/** Shared brush stamps keep the preview and transmitted pixel mask in the same coordinates. */
export function* imageRedactionStamps(
  stroke: ImageRedactionStroke,
): Generator<{ x: number; y: number }> {
  let previous = stroke.points[0];
  if (!previous) return;
  for (const point of stroke.points) {
    const steps = Math.max(
      1,
      Math.ceil(
        Math.hypot(point.x - previous.x, point.y - previous.y) /
          Math.max(1, stroke.size / 4),
      ),
    );
    for (let step = 0; step <= steps; step++)
      yield {
        x: previous.x + ((point.x - previous.x) * step) / steps,
        y: previous.y + ((point.y - previous.y) * step) / steps,
      };
    previous = point;
  }
}
