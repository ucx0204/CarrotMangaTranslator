import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type {
  PageImageExportChapterSelection,
  PageImageExportFormat,
} from "../../../shared/pageImageExportTypes";
import type { PageJobTargetSnapshot } from "../../../shared/pageRevision";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { exportGateway as mangaGateway } from "../api/exportGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import {
  failExportJob,
  saveDirtyChanges,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export type ManualRasterExportOptions = {
  omitText?: boolean;
  outputFormat?: PageImageExportFormat;
  jpegQuality?: number;
  webpQuality?: number;
  preserveSourceNames?: boolean;
  destinationMode?: "timestamped" | "fixed";
  collisionPolicy?: "replace" | "skip" | "cancel";
};

export type ManualPsdExportOptions = {
  omitText?: boolean;
  collisionPolicy?: "replace" | "skip" | "cancel";
};

export type ManualExportAction<TOptions> = (
  selections: PageImageExportChapterSelection[],
  expectedTargets?: PageJobTargetSnapshot[],
  options?: TOptions,
) => Promise<boolean>;

export function useExportPageImagesAction(
  options: UseInpaintingActionsOptions,
): ManualExportAction<ManualRasterExportOptions> {
  return useManualExportAction(options, "raster");
}

export function useExportPagePsdAction(
  options: UseInpaintingActionsOptions,
): ManualExportAction<ManualPsdExportOptions> {
  return useManualExportAction(options, "psd");
}

function useManualExportAction(
  {
    currentChapter,
    dirty,
    jobActive,
    pushStatus,
    saveNow,
    setJobState,
  }: UseInpaintingActionsOptions,
  kind: "raster" | "psd",
): ManualExportAction<ManualRasterExportOptions | ManualPsdExportOptions> {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (selections, expectedTargets, exportOptions) => {
      if (!currentChapter || jobActive || selections.length === 0) return false;
      const runtime = { pushStatus, setJobState };
      try {
        await saveDirtyChanges(dirty, saveNow);
      } catch (error) {
        reportExportFailure(
          error,
          t("inpainting.export.saveFailed"),
          runtime,
          t,
        );
      }
      return startPageExport({
        currentChapter,
        expectedTargets,
        kind,
        options: exportOptions,
        runtime,
        selections,
        t,
      });
    },
    [
      currentChapter,
      dirty,
      jobActive,
      kind,
      pushStatus,
      saveNow,
      setJobState,
      t,
    ],
  );
}

type ExportRuntime = Pick<
  UseInpaintingActionsOptions,
  "pushStatus" | "setJobState"
>;

async function startPageExport({
  currentChapter,
  expectedTargets,
  kind,
  options,
  runtime,
  selections,
  t,
}: {
  currentChapter: ChapterSnapshot;
  expectedTargets?: PageJobTargetSnapshot[];
  kind: "raster" | "psd";
  options?: ManualRasterExportOptions | ManualPsdExportOptions;
  runtime: ExportRuntime;
  selections: PageImageExportChapterSelection[];
  t: ReturnType<typeof useTranslation>["t"];
}): Promise<boolean> {
  try {
    const base = {
      workId: currentChapter.workId,
      selections,
      expectedTargets,
      ...(options?.omitText ? { omitText: true } : {}),
      ...(options?.collisionPolicy
        ? { collisionPolicy: options.collisionPolicy }
        : {}),
    };
    const result =
      kind === "psd"
        ? await mangaGateway.exportPagePsd(base)
        : await mangaGateway.exportPageImages({
            ...base,
            ...(options as ManualRasterExportOptions),
          });
    if (!result || result.status === "cancelled") return false;
    runtime.pushStatus(
      result.openError
        ? t("inpainting.export.openFolderFailed", { path: result.outputDir })
        : t(
            kind === "psd"
              ? "inpainting.export.successPsd"
              : "inpainting.export.success",
            { count: result.pageCount },
          ),
    );
    return true;
  } catch (error) {
    reportExportFailure(error, t("inpainting.export.failed"), runtime, t);
  }
}

function reportExportFailure(
  error: unknown,
  fallback: string,
  { pushStatus, setJobState }: ExportRuntime,
  t: ReturnType<typeof useTranslation>["t"],
): never {
  console.error(error);
  failExportJob(
    setJobState,
    pushStatus,
    formatErrorMessage(error, fallback),
    t("inpainting.export.failedTitle"),
  );
  throw error;
}
