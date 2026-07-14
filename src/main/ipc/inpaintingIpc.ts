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
  InpaintingRetouchResult,
  InpaintingRevertResult,
  ReleaseInpaintingHistoryTransactionsResult,
  SetPageInpaintingResultResult,
  StartInpaintingResult,
} from "../../shared/inpaintingTypes";
import { applyInpaintingRetouch, sampleImageColor } from "../inpainting";
import { disposeCachedInpaintingEngines } from "../inpainting/inpaintingEnginePool";
import type { InpaintingRevisionStore } from "../inpainting/inpaintingRevisionStore";
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

function assertNoActiveJob(context: IpcContext): void {
  if (context.jobs.hasActive) {
    throw new Error(tMain("jobs.active"));
  }
}

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
        context,
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
    async (): Promise<{ disposed: boolean }> => ({
      disposed: await disposeCachedInpaintingEngines("renderer-exit"),
    }),
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
      assertNoActiveJob(context);
      const chapter = await openChapter(request.chapterId);
      const page = chapter.pages.find(
        (candidate) => candidate.id === request.pageId,
      );
      if (!page) {
        throw new Error(tMain("inpainting.errors.retouchPageNotFound"));
      }
      const nextPage = await applyInpaintingRetouch(page, {
        mode: request.mode,
        points: request.points,
        radiusPx: request.radiusPx,
        color: request.color,
        decodeFallback: context.decodeImage,
      });
      const transactionId = revisionStore.beginTransaction();
      const changeAdded = revisionStore.addChange(transactionId, {
        chapterId: request.chapterId,
        pageId: request.pageId,
        beforePath: page.inpaintedImagePath,
        afterPath: nextPage.inpaintedImagePath,
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
      assertNoActiveJob(context);
      const chapter = await setPageInpaintingResult(
        request.chapterId,
        request.pageId,
        request.inpaintedImagePath ?? undefined,
        {
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
      assertNoActiveJob(context);
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
      const reverted = pages.map((page) => ({
        ...page,
        inpaintedImagePath: undefined,
        updatedAt: new Date().toISOString(),
      }));
      const transactionId = revisionStore.beginTransaction();
      for (const page of pages) {
        revisionStore.addChange(transactionId, {
          chapterId: request.chapterId,
          pageId: page.id,
          beforePath: page.inpaintedImagePath,
          afterPath: undefined,
        });
      }
      let saved: Awaited<ReturnType<typeof updatePagesAfterInpainting>>;
      try {
        saved = await updatePagesAfterInpainting(request.chapterId, reverted, {
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
      assertNoActiveJob(context);
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
