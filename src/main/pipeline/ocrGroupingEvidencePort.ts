import type { TranslationOptions } from "../appSettings";
import type { OcrBboxResult } from "./types";

export type OcrGroupingEvidencePort = {
  annotate: (
    options: TranslationOptions,
    result: OcrBboxResult,
  ) => Promise<OcrBboxResult>;
  annotateBatch: (
    optionsList: TranslationOptions[],
    results: OcrBboxResult[],
  ) => Promise<OcrBboxResult[]>;
  releaseIdleResources: (reason: string) => Promise<boolean>;
};
