import { z } from "zod";
import {
  PageWorkflowPlanSchema,
  PageWorkflowPresetSchema,
  PageWorkflowFavoritePresetIdsSchema,
} from "./pageWorkflowTypes";
import { SUPPORTED_UI_LOCALES } from "./uiLocales";
import { codexTypesettingPreferencesSchema } from "./codexTypesettingSchemas";
export const UiSettingsSchema = z
  .object({
    locale: z.enum(SUPPORTED_UI_LOCALES).optional(),
    hayaiTranslationUi: z.enum(["classic", "workflow"]).optional(),
    pageWorkflowDefault: PageWorkflowPlanSchema.optional(),
    pageWorkflowPresets: z.array(PageWorkflowPresetSchema).max(50).optional(),
    pageWorkflowFavoritePresetIds:
      PageWorkflowFavoritePresetIdsSchema.optional(),
    blockReadingSize: z.number().int().min(12).max(24).optional(),
    inpaintingGuideHidden: z.boolean().optional(),
    translationWorkflowDefault: z.enum(["standard", "cumulative"]).optional(),
    cumulativeContextDetailDefault: z
      .enum(["detailed", "balanced", "essential"])
      .optional(),
    blockModeDefault: z.enum(["auto", "keep"]).optional(),
    codexTypesettingPreferences: codexTypesettingPreferencesSchema.optional(),
    naturalTextLayoutDefault: z.boolean().optional(),
    autoFontMatchingDefault: z.boolean().optional(),
    aiFontSizeMatchingDefault: z.boolean().optional(),
    fontSizeAutoFitDefault: z.boolean().optional(),
    sfxAutoFontMatchingDefault: z.boolean().optional(),
    sfxInpaintAfterTranslationDefault: z.boolean().optional(),
    eraseOriginalWorkflowDefault: z.boolean().optional(),
    bubbleLayoutWorkflowDefault: z.boolean().optional(),
    codexErasureDefault: z.boolean().optional(),
    wheelZoomSensitivityPercent: z.number().int().min(1).max(10).optional(),
  })
  .strict()
  .optional();
