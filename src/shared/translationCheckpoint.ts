import type {
  FontMatchingSemanticRole,
  FontMatchingSourceStyleV2,
} from "./fontMatchingProfileTypes";
import type { PageRevision } from "./pageRevisionTypes";

export const TRANSLATION_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const TRANSLATION_CHECKPOINT_PIPELINE_CONTRACT =
  "whole-page-prepared-v1" as const;
export const FONT_CONTINUITY_SCHEMA_VERSION = 1 as const;
export const FONT_CONTINUITY_RUNTIME_CONTRACT =
  "font-matching-continuity-v1" as const;

export type TranslationCheckpointMetadata = Readonly<{
  schemaVersion: typeof TRANSLATION_CHECKPOINT_SCHEMA_VERSION;
  pipelineContractVersion: typeof TRANSLATION_CHECKPOINT_PIPELINE_CONTRACT;
  artifactPath: string;
  sha256: string;
  byteSize: number;
  inputRevision: PageRevision;
  sourceLanguage: string;
  targetLanguage: string;
  blockMode: "auto" | "keep";
  savedAt: string;
}>;

export type FontContinuityObservation = Readonly<{
  pageId: string;
  blockId: string;
  role: FontMatchingSemanticRole;
  selectedFontId: string;
  confidence: number;
  orientation: "horizontal" | "vertical";
  sourceStyle: FontMatchingSourceStyleV2;
  modelVersion: string;
  candidateOrderSha256: string;
}>;

export type FontContinuityMetadata = Readonly<{
  schemaVersion: typeof FONT_CONTINUITY_SCHEMA_VERSION;
  runtimeContractVersion: typeof FONT_CONTINUITY_RUNTIME_CONTRACT;
  observations: readonly FontContinuityObservation[];
  savedAt: string;
}>;
