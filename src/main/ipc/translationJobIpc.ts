import {
  RegionAnalysisRequestSchema,
  StartAnalysisRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import type {
  RegionAnalysisResult,
  StartAnalysisResult,
} from "../../shared/types";
import { startAnalysisJob, translateRegionJob } from "../jobs/translationJobs";
import type { IpcContext } from "./context";
import { trustedHandle } from "./trustedIpc";

export function registerTranslationJobIpc(context: IpcContext): void {
  trustedHandle(
    context,
    "job:start-analysis",
    async (_event, rawRequest: unknown): Promise<StartAnalysisResult> =>
      startAnalysisJob(
        context,
        parseIpcPayload(StartAnalysisRequestSchema, rawRequest, "번역 작업"),
      ),
  );

  trustedHandle(
    context,
    "job:translate-region",
    async (_event, rawRequest: unknown): Promise<RegionAnalysisResult> =>
      translateRegionJob(
        context,
        parseIpcPayload(RegionAnalysisRequestSchema, rawRequest, "영역 번역"),
      ),
  );
}
