import {
  RegionAnalysisRequestSchema,
  StartAnalysisRequestSchema,
  StartSoundEffectTranslationRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { translationJobIpcContracts } from "../../shared/ipcContracts";
import type {
  RegionAnalysisResult,
  StartAnalysisResult,
  StartSoundEffectTranslationResult,
} from "../../shared/analysisTypes";
import {
  startAnalysisJob,
  startSoundEffectTranslationJob,
  translateRegionJob,
} from "../jobs/translationJobs";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";

export function registerTranslationJobIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    translationJobIpcContracts.startAnalysis,
    async (_event, rawRequest: unknown): Promise<StartAnalysisResult> =>
      startAnalysisJob(
        context,
        parseIpcPayload(
          StartAnalysisRequestSchema,
          rawRequest,
          tMain("ipc.labels.translationJob"),
        ),
      ),
  );

  trustedHandleContract(
    context,
    translationJobIpcContracts.translateRegion,
    async (_event, rawRequest: unknown): Promise<RegionAnalysisResult> =>
      translateRegionJob(
        context,
        parseIpcPayload(
          RegionAnalysisRequestSchema,
          rawRequest,
          tMain("ipc.labels.regionTranslation"),
        ),
      ),
  );

  trustedHandleContract(
    context,
    translationJobIpcContracts.startSoundEffectTranslation,
    async (
      _event,
      rawRequest: unknown,
    ): Promise<StartSoundEffectTranslationResult> =>
      startSoundEffectTranslationJob(
        context,
        parseIpcPayload(
          StartSoundEffectTranslationRequestSchema,
          rawRequest,
          "효과음 번역",
        ),
      ),
  );
}
