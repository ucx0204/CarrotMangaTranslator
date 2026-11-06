import { z } from "zod";
import {
  CODEX_IMAGE_GENERATION_MODELS,
  migrateCodexImageGenerationModel,
} from "./codexSettings";

export const CodexImageGenerationModelSchema = z.preprocess(
  migrateCodexImageGenerationModel,
  z.enum(CODEX_IMAGE_GENERATION_MODELS),
);
