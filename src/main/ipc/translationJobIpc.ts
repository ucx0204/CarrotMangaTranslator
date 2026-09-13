import { registerImageRedactionWorkspaceIpc } from "./imageRedactionWorkspaceIpc";
import { confirmImageRedaction } from "../jobs/imageRedactionReview";
import {
  readImageRedactionState,
  setImageRedactionEnabled,
} from "../imageRedactionStore";
import { confirmRegionTranslation } from "../jobs/regionTranslationReview";
import { confirmSoundEffectTextReview } from "../application/soundEffectTextReview";
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
  registerImageRedactionWorkspaceIpc(context);
  trustedHandleContract(
    context,
    translationJobIpcContracts.confirmSoundEffectTextReview,
    async (_event, request) => confirmSoundEffectTextReview(request),
  );
  trustedHandleContract(
    context,
    translationJobIpcContracts.confirmImageRedaction,
    async (_event, request) => confirmImageRedaction(request),
  );
  trustedHandleContract(
    context,
    translationJobIpcContracts.getImageRedactionEnabled,
    async () => (await readImageRedactionState()).enabled,
  );
  trustedHandleContract(
    context,
    translationJobIpcContracts.setImageRedactionEnabled,
    async (_event, enabled) => {
      await setImageRedactionEnabled(enabled);
      return enabled;
    },
  );
  trustedHandleContract(
    context,
    translationJobIpcContracts.confirmRegionTranslation,
    async (_event, request) => confirmRegionTranslation(request),
  );
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
