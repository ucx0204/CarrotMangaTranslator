import { z } from "zod";
import {
  AmdRocmTargetSchema,
  ApiReasoningEffortSchema,
  CustomHeadersJsonObjectStringSchema,
  FluxBackendSchema,
  GemmaVramModeSchema,
  InpaintingModelSchema,
  KoharuInpaintingBackendSchema,
  JsonObjectStringSchema,
  LlamaRuntimeProfileSchema,
  MAX_MAX_TOKENS,
  MIN_CONTEXT_TOKENS,
  MIN_MAX_TOKENS,
  OcrGpuBackendSchema,
  OcrQualityModeSchema,
  OpenAiCompatibleBaseUrlSchema,
  filePath,
  hexColor,
} from "./ipcSchemaPrimitives";

export const AppSettingsSchema = z
  .object({
    modelProvider: z.enum(["gemma", "openai-codex", "openai-api"]),
    gemma: z
      .object({
        modelSource: z.enum(["huggingface", "local"]),
        modelRepo: z.string().min(1).max(300),
        modelFile: z.string().min(1).max(300),
        mmprojRepo: z.string().min(1).max(300).optional(),
        mmprojFile: z.string().min(1).max(300).optional(),
        localModelPath: filePath.optional(),
        localMmprojPath: filePath.optional(),
        vramMode: GemmaVramModeSchema,
        llamaRuntimeProfile: LlamaRuntimeProfileSchema.optional(),
        llamaRocmTarget: AmdRocmTargetSchema.optional(),
      })
      .strict(),
    codex: z
      .object({
        model: z.string().min(1).max(120),
        reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]),
        oauthPort: z.number().int().min(1).max(65535),
      })
      .strict(),
    api: z
      .object({
        baseUrl: OpenAiCompatibleBaseUrlSchema,
        model: z.string().min(1).max(200),
        apiKey: z.string().max(4000).optional(),
        temperature: z.number().min(0).max(2).nullable().optional(),
        topP: z.number().min(0).max(1).nullable().optional(),
        topK: z.number().int().min(1).max(1000).nullable().optional(),
        reasoningEffort: ApiReasoningEffortSchema.nullable().optional(),
        extraBodyJson: JsonObjectStringSchema.optional(),
        customHeadersJson: CustomHeadersJsonObjectStringSchema.optional(),
      })
      .strict(),
    ocr: z
      .object({
        device: z.enum(["cpu", "gpu"]),
        qualityMode: OcrQualityModeSchema,
        gpuCudaTag: z
          .string()
          .regex(/^cu\d+$/i)
          .optional(),
        gpuBackend: OcrGpuBackendSchema.optional(),
      })
      .strict(),
    ui: z
      .object({
        inpaintingGuideHidden: z.boolean().optional(),
        twoPassByDefault: z.boolean().optional(),
        analysisScopeDefault: z.enum(["work", "missing", "chapter"]).optional(),
      })
      .strict()
      .optional(),
    inpainting: z
      .object({
        model: InpaintingModelSchema.optional(),
        fluxBackend: FluxBackendSchema.optional(),
        koharuBackend: KoharuInpaintingBackendSchema.optional(),
      })
      .strict()
      .optional(),
    blockFormatDefaults: z
      .object({
        renderDirection: z.enum(["auto", "horizontal", "vertical"]),
        textAlign: z.enum(["left", "center", "right"]),
        fontFamily: z.string().max(120).optional(),
        autoFitText: z.boolean(),
        fontSizePx: z.number().min(1).max(512),
        lineHeight: z.number().min(0.5).max(4),
        letterSpacing: z.number().min(-0.5).max(2),
        textColor: hexColor,
        outlineEnabled: z.boolean(),
        outlineColor: hexColor,
        outlineWidthScale: z.number().min(0).max(8),
        bold: z.boolean(),
        italic: z.boolean(),
      })
      .strict()
      .optional(),
    keybindings: z.record(z.string().max(80), z.string().max(60)).optional(),
    runtimeHardware: z
      .object({
        gpuVendor: z.enum(["nvidia", "amd", "unknown"]),
        gpuName: z.string().max(300).nullable().optional(),
        llamaRocmTarget: AmdRocmTargetSchema.nullable().optional(),
        supportsRocm: z.boolean().optional(),
        supportsVulkan: z.boolean().optional(),
      })
      .strict()
      .optional(),
    maxTokens: z.number().int().min(MIN_MAX_TOKENS).max(MAX_MAX_TOKENS),
    ctx: z.number().int().min(MIN_CONTEXT_TOKENS),
  })
  .strict();
