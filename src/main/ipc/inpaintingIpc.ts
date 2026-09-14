import {
  ApplyInpaintingHistoryTransactionRequestSchema,
  InpaintingColorSampleRequestSchema,
  InpaintingRetouchRequestSchema,
  InpaintingRevertRequestSchema,
  ReleaseInpaintingHistoryTransactionsRequestSchema,
  SetPageInpaintingResultRequestSchema,
  StartInpaintingRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { inpaintingIpcContracts } from "../../shared/ipcContracts";
import type {
  ApplyInpaintingHistoryTransactionResult,
  InpaintingColorSampleResult,
  InpaintingRetouchRequest,
  InpaintingRetouchResult,
  InpaintingRevertResult,
  ReleaseInpaintingHistoryTransactionsResult,
  SetPageInpaintingResultResult,
  StartInpaintingResult,
} from "../../shared/inpaintingTypes";
import { applyInpaintingRetouch, sampleImageColor } from "../inpainting";
import { disposeCachedInpaintingEngines } from "../inpainting/inpaintingEnginePool";
import type { InpaintingRevisionStore } from "../inpainting/inpaintingRevisionStore";
import { prepareInpaintingRevertRevision } from "../inpainting/inpaintingRevisionPreparation";
import { startInpaintingJob } from "../jobs/inpaintingJobs";
import {
  assertLibraryImagePath,
  openChapter,
  setPageInpaintingResult,
  updatePagesAfterInpainting,
} from "../library";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";
import { createPageRevision } from "../../shared/pageRevision";
import { pageContentResource } from "../../shared/appActivityTypes";
import { withLibraryContentEdit } from "../library/lock";
import { getAppSettings } from "../settingsStore";

function requireRevisionStore(context: IpcContext): InpaintingRevisionStore {
  if (!context.inpaintingRevisionStore) {
    throw new Error("인페인팅 작업 기록 저장소가 준비되지 않았습니다.");
  }
  return context.inpaintingRevisionStore;
}

export function registerInpaintingIpc(context: IpcContext): void {
  registerInpaintingJobIpc(context);
  registerInpaintingRetouchIpc(context);
  registerInpaintingResultIpc(context);
  registerInpaintingRevertIpc(context);
  registerInpaintingHistoryIpc(context);
  registerInpaintingUtilityIpc(context);
}

function registerInpaintingJobIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    inpaintingIpcContracts.startInpainting,
    async (_event, rawRequest: unknown): Promise<StartInpaintingResult> =>
      startInpaintingJob(
        {
          ...context,
          executionSettings: await getAppSettings(context.appPaths),
        },
        parseIpcPayload(
          StartInpaintingRequestSchema,
          rawRequest,
          tMain("ipc.labels.inpaintingJob"),
        ),
      ),
  );

  trustedHandleContract(
    context,
    inpaintingIpcContracts.disposeInpaintingEngine,
    async (): Promise<{ disposed: boolean }> => {
      const lease = context.jobs.gate.acquire({
        id: "dispose-inpainting",
        category: "operation",
        kind: "runtime-disposal",
        mutatesLibrary: false,
        blocksQuit: true,
        resources: [{ kind: "model-runtime", scope: "*", access: "write" }],
      });
      try {
        return {
          disposed: await disposeCachedInpaintingEngines("renderer-exit"),
        };
      } finally {
        lease.release();
      }
    },
  );
}

function registerInpaintingRetouchIpc(context: IpcContext): void {
  const revisionStore = requireRevisionStore(context);
  trustedHandleContract(
    context,
    inpaintingIpcContracts.applyInpaintingRetouch,
    async (_event, rawRequest: unknown): Promise<InpaintingRetouchResult> => {
      const request = parseIpcPayload(
        InpaintingRetouchRequestSchema,
        rawRequest,
        tMain("ipc.labels.inpaintingRetouch"),
      );
      return withLibraryContentEdit(
        [pageContentResource(request.chapterId, request.pageId)],
        async () => {
          const page = await readRetouchPage(request);
          const nextPage = await applyInpaintingRetouch(page, {
            mode: request.mode,
            geometry: request.geometry,
            color: request.color,
            decodeFallback: context.decodeImage,
          });
          const transactionId = revisionStore.beginTransaction();
          const changeAdded = revisionStore.addChange(transactionId, {
            chapterId: request.chapterId,
            pageId: request.pageId,
            beforeRevision: createPageRevision(page),
            afterRevision: createPageRevision(nextPage),
            beforePath: page.inpaintedImagePath,
            afterPath: nextPage.inpaintedImagePath,
            beforeMaskPath: page.inpaintMaskPath,
            afterMaskPath: nextPage.inpaintMaskPath,
            beforeMaskProvenance: page.maskProvenance,
            afterMaskProvenance: nextPage.maskProvenance,
            beforeTranslationCompletion: page.translationCompletion,
            afterTranslationCompletion: nextPage.translationCompletion,
          });
          if (!changeAdded) {
            revisionStore.discardIfEmpty(transactionId);
          }
          let saved: Awaited<ReturnType<typeof updatePagesAfterInpainting>>;
          try {
            saved = await updatePagesAfterInpainting(
              request.chapterId,
              [nextPage],
              {
                expectedTargets: [
                  {
                    chapterId: request.chapterId,
                    pageId: request.pageId,
                    revision: request.expectedRevision,
                  },
                ],
                retainedInpaintedArtifactPaths:
                  revisionStore.getRetainedArtifactPaths(
                    request.chapterId,
                    request.retainedInpaintedArtifactPaths,
                  ),
              },
            );
          } catch (error) {
            if (changeAdded) {
              await revisionStore.releaseTransactions([transactionId]);
            }
            throw error;
          }
          return {
            chapter: saved,
            pageId: request.pageId,
            historyTransaction: changeAdded
              ? revisionStore.getReference(transactionId)
              : undefined,
          };
        },
      );
    },
  );
}

async function readRetouchPage(request: InpaintingRetouchRequest) {
  const chapter = await openChapter(request.chapterId);
  const page = chapter.pages.find(
    (candidate) => candidate.id === request.pageId,
  );
  if (!page) {
    throw new Error(tMain("inpainting.errors.retouchPageNotFound"));
  }
  if (createPageRevision(page) !== request.expectedRevision) {
    throw new Error(
      "[PAGE_SAVE_CONFLICT] 페이지가 변경되었습니다. 최신 내용을 확인해 주세요.",
    );
  }
  return page;
}

function registerInpaintingResultIpc(context: IpcContext): void {
  const revisionStore = requireRevisionStore(context);
  trustedHandleContract(
    context,
    inpaintingIpcContracts.setPageInpaintingResult,
    async (
      _event,
      rawRequest: unknown,
    ): Promise<SetPageInpaintingResultResult> => {
      const request = parseIpcPayload(
        SetPageInpaintingResultRequestSchema,
        rawRequest,
        tMain("ipc.labels.inpaintingApply"),
      );
      const chapter = await setPageInpaintingResult(
        request.chapterId,
        request.pageId,
        request.inpaintedImagePath ?? undefined,
        {
          expectedTargets: [
            {
              chapterId: request.chapterId,
              pageId: request.pageId,
              revision: request.expectedRevision,
            },
          ],
          retainedInpaintedArtifactPaths:
            revisionStore.getRetainedArtifactPaths(
              request.chapterId,
              request.retainedInpaintedArtifactPaths,
            ),
        },
      );
      return {
        chapter,
        pageId: request.pageId,
      };
    },
  );
}

function registerInpaintingRevertIpc(context: IpcContext): void {
  const revisionStore = requireRevisionStore(context);
  trustedHandleContract(
    context,
    inpaintingIpcContracts.revertInpainting,
    async (_event, rawRequest: unknown): Promise<InpaintingRevertResult> => {
      const request = parseIpcPayload(
        InpaintingRevertRequestSchema,
        rawRequest,
        tMain("ipc.labels.inpaintingRestore"),
      );
      const chapter = await openChapter(request.chapterId);
      const pages =
        request.scope === "page"
          ? chapter.pages.filter(
              (page) => page.id === request.pageId && page.inpaintedImagePath,
            )
          : chapter.pages.filter((page) => page.inpaintedImagePath);
      if (pages.length === 0) {
        return {
          chapter,
          pagesChanged: 0,
        };
      }
      const revisions = pages.map((page) =>
        prepareInpaintingRevertRevision({
          chapterId: request.chapterId,
          page,
        }),
      );
      const reverted = revisions.map((revision) => revision.revertedPage);
      const transactionId = revisionStore.beginTransaction();
      for (const revision of revisions) {
        revisionStore.addChange(transactionId, revision.change);
      }
      let saved: Awaited<ReturnType<typeof updatePagesAfterInpainting>>;
      try {
        saved = await updatePagesAfterInpainting(request.chapterId, reverted, {
          expectedTargets: pages.map((page) => ({
            chapterId: request.chapterId,
            pageId: page.id,
            revision: createPageRevision(page),
          })),
          retainedInpaintedArtifactPaths:
            revisionStore.getRetainedArtifactPaths(request.chapterId),
        });
      } catch (error) {
        await revisionStore.releaseTransactions([transactionId]);
        throw error;
      }
      return {
        chapter: saved,
        pagesChanged: reverted.length,
        historyTransaction: revisionStore.getReference(transactionId),
      };
    },
  );
}

function registerInpaintingHistoryIpc(context: IpcContext): void {
  const revisionStore = requireRevisionStore(context);
  trustedHandleContract(
    context,
    inpaintingIpcContracts.applyInpaintingHistoryTransaction,
    async (
      _event,
      rawRequest: unknown,
    ): Promise<ApplyInpaintingHistoryTransactionResult> => {
      const request = parseIpcPayload(
        ApplyInpaintingHistoryTransactionRequestSchema,
        rawRequest,
        tMain("ipc.labels.inpaintingApply"),
      );
      return revisionStore.applyTransaction(request);
    },
  );

  trustedHandleContract(
    context,
    inpaintingIpcContracts.releaseInpaintingHistoryTransactions,
    async (
      _event,
      rawRequest: unknown,
    ): Promise<ReleaseInpaintingHistoryTransactionsResult> => {
      const request = parseIpcPayload(
        ReleaseInpaintingHistoryTransactionsRequestSchema,
        rawRequest,
        tMain("ipc.labels.inpaintingApply"),
      );
      return {
        released: await revisionStore.releaseTransactions(
          request.transactionIds,
        ),
      };
    },
  );
}

function registerInpaintingUtilityIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    inpaintingIpcContracts.sampleInpaintingColor,
    async (
      _event,
      rawRequest: unknown,
    ): Promise<InpaintingColorSampleResult> => {
      const request = parseIpcPayload(
        InpaintingColorSampleRequestSchema,
        rawRequest,
        tMain("ipc.labels.colorSample"),
      );
      const imagePath = assertLibraryImagePath(request.imagePath);
      return {
        color: await sampleImageColor(
          imagePath,
          request.x,
          request.y,
          context.decodeImage,
        ),
      };
    },
  );
}
