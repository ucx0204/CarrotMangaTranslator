import { z } from "zod";

const codexPagePreviewSchema = z
  .object({
    pageId: z.string().min(1).max(200),
    name: z.string().min(1).max(1000),
    imagePath: z.string().min(1).max(32768),
    width: z.number().positive(),
    height: z.number().positive(),
    stage: z.enum(["reading", "background", "review"]),
    regions: z
      .array(
        z
          .object({
            source: z.string().max(20000),
            translation: z.string().max(20000),
            bbox: z
              .object({
                x: z.number().min(0).max(1000),
                y: z.number().min(0).max(1000),
                w: z.number().positive().max(1000),
                h: z.number().positive().max(1000),
              })
              .strict(),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();

export type CodexPagePreview = z.infer<typeof codexPagePreviewSchema>;

export const codexProgressSchema = z
  .object({
    stage: z.enum(["reading", "fonts", "typesetting"]),
    step: z.enum([
      "reading",
      "confirmText",
      "erasurePlan",
      "groupFonts",
      "matchFonts",
      "background",
      "sfx",
      "layout",
      "review",
      "saving",
      "retry",
    ]),
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    /** One-based page number at the IPC boundary. */
    page: z.number().int().positive().optional(),
    part: z.number().int().positive().optional(),
    parts: z.number().int().positive().optional(),
    attempt: z.number().int().positive().optional(),
    delaySeconds: z.number().nonnegative().optional(),
    preview: codexPagePreviewSchema.optional(),
  })
  .strict();

export type CodexTypesettingProgress = z.infer<typeof codexProgressSchema>;
export type CodexProgressUpdate = Partial<
  Omit<CodexTypesettingProgress, "total">
> & {
  step: CodexTypesettingProgress["step"];
  /** Emitted only after the page repository accepts the finished result. */
  pageCommitted?: boolean;
};
