import {
  InpaintingColorSampleRequestSchema,
  InpaintingExportRequestSchema,
  InpaintingRetouchRequestSchema,
  InpaintingRevertRequestSchema,
  SetPageInpaintingResultRequestSchema,
  StartInpaintingRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { inpaintingIpcContracts } from "../../shared/ipcContracts";
import type {
  InpaintingColorSampleResult,
  InpaintingExportResult,
  InpaintingRetouchResult,
  InpaintingRevertResult,
  SetPageInpaintingResultResult,
  StartInpaintingResult,
} from "../../shared/inpaintingTypes";
import { applyInpaintingRetouch, sampleImageColor } from "../inpainting";
import { disposeCachedInpaintingEngines } from "../inpainting/inpaintingEnginePool";
import {
  exportInpaintingResults,
  startInpaintingJob,
} from "../jobs/inpaintingJobs";
import {
  assertLibraryImagePath,
  openChapter,
  setPageInpaintingResult,
  updatePagesAfterInpainting,
} from "../library";
import type { IpcContext } from "./context";
import { trustedHandleContract } from "./trustedIpc";

function assertNoActiveJob(context: IpcContext): void {
  if (context.jobs.hasActive) {
    throw new Error("이미 실행 중인 작업이 있습니다.");
  }
}

export function registerInpaintingIpc(context: IpcContext): void {
  registerInpaintingJobIpc(context);
  registerInpaintingRetouchIpc(context);
  registerInpaintingResultIpc(context);
  registerInpaintingRevertIpc(context);
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
          "인페인팅 작업",
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
  trustedHandleContract(
    context,
    inpaintingIpcContracts.applyInpaintingRetouch,
    async (_event, rawRequest: unknown): Promise<InpaintingRetouchResult> => {
      const request = parseIpcPayload(
        InpaintingRetouchRequestSchema,
        rawRequest,
        "인페인팅 보정",
      );
      assertNoActiveJob(context);
      const chapter = await openChapter(request.chapterId);
      const page = chapter.pages.find(
        (candidate) => candidate.id === request.pageId,
      );
      if (!page) {
        throw new Error("리터치할 페이지를 찾지 못했습니다.");
      }
      const nextPage = await applyInpaintingRetouch(page, {
        mode: request.mode,
        points: request.points,
        radiusPx: request.radiusPx,
        color: request.color,
        decodeFallback: context.decodeImage,
      });
      const saved = await updatePagesAfterInpainting(
        request.chapterId,
        [nextPage],
        {
          retainedInpaintedArtifactPaths:
            request.retainedInpaintedArtifactPaths,
        },
      );
      return {
        chapter: saved,
        pageId: request.pageId,
      };
    },
  );
}

function registerInpaintingResultIpc(context: IpcContext): void {
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
        "인페인팅 결과 적용",
      );
      assertNoActiveJob(context);
      const chapter = await setPageInpaintingResult(
        request.chapterId,
        request.pageId,
        request.inpaintedImagePath ?? undefined,
        {
          retainedInpaintedArtifactPaths:
            request.retainedInpaintedArtifactPaths,
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
  trustedHandleContract(
    context,
    inpaintingIpcContracts.revertInpainting,
    async (_event, rawRequest: unknown): Promise<InpaintingRevertResult> => {
      const request = parseIpcPayload(
        InpaintingRevertRequestSchema,
        rawRequest,
        "인페인팅 되돌리기",
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
      const saved = await updatePagesAfterInpainting(
        request.chapterId,
        reverted,
      );
      return {
        chapter: saved,
        pagesChanged: reverted.length,
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
        "색상 샘플",
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

  trustedHandleContract(
    context,
    inpaintingIpcContracts.exportInpaintingResults,
    async (_event, rawRequest: unknown): Promise<InpaintingExportResult> =>
      exportInpaintingResults(
        context,
        parseIpcPayload(InpaintingExportRequestSchema, rawRequest, "결과 출력"),
      ),
  );
}
