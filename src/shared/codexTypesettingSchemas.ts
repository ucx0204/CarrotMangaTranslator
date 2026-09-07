import { z } from "zod";

export const codexFontPresetSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    fonts: z
      .array(
        z
          .object({
            fontId: z.string().min(1).max(200),
            purpose: z.string().max(600),
          })
          .strict(),
      )
      .min(1)
      .max(10)
      .refine(
        (fonts) =>
          new Set(fonts.map((font) => font.fontId)).size === fonts.length,
        "A font may occur only once in a preset.",
      ),
  })
  .strict();

export const codexTypesettingOptionsSchema = z
  .object({
    version: z.literal(1),
    eraseOriginal: z.boolean().optional(),
    regionOutput: z.enum(["text", "image"]).optional(),
    preset: codexFontPresetSchema,
    sfxRendering: z.enum(["image", "font"]).default("image"),
  })
  .strict();

export const codexTypesettingPreferencesSchema = z
  .object({
    enabled: z.boolean(),
    eraseOriginal: z.boolean().optional(),
    sfxRendering: z.enum(["image", "font"]).default("image"),
    selectedPresetId: z.string().min(1).max(100),
    presets: z.array(codexFontPresetSchema).min(1).max(30),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.presets.map((preset) => preset.id);
    if (
      new Set(ids).size !== ids.length ||
      !ids.includes(value.selectedPresetId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid preset selection.",
      });
    }
  });
