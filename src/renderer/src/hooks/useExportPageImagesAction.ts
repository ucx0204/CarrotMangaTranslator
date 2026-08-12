import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { PageImageExportChapterSelection } from "../../../shared/pageImageExportTypes";
import type { PageImageExportFormat } from "../../../shared/pageImageExportTypes";
import type { PageJobTargetSnapshot } from "../../../shared/pageRevision";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { exportGateway as mangaGateway } from "../api/exportGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import {
  failExportJob,
  saveDirtyChanges,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export function useExportPageImagesAction({
  currentChapter,
  dirty,
  jobActive,
  pushStatus,
  saveNow,
  setJobState,
}: UseInpaintingActionsOptions): (
  selections: PageImageExportChapterSelection[],
  expectedTargets?: PageJobTargetSnapshot[],
  options?: { omitText?: boolean; outputFormat?: PageImageExportFormat },
) => Promise<boolean> {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (selections, expectedTargets, options) => {
      if (!currentChapter || jobActive || selections.length === 0) {
        return false;
      }
      const runtime = { pushStatus, setJobState };
      await saveExportChanges({ dirty, saveNow, runtime, t });
      return startPageImageExport({
        currentChapter,
        expectedTargets,
        options,
        runtime,
        selections,
        t,
      });
    },
    [currentChapter, dirty, jobActive, pushStatus, saveNow, setJobState, t],
  );
}

type ExportRuntime = Pick<
  UseInpaintingActionsOptions,
  "pushStatus" | "setJobState"
>;

async function saveExportChanges({
  dirty,
  saveNow,
  runtime,
  t,
}: Pick<UseInpaintingActionsOptions, "dirty" | "saveNow"> & {
  runtime: ExportRuntime;
  t: ReturnType<typeof useTranslation>["t"];
}): Promise<void> {
  try {
    await saveDirtyChanges(dirty, saveNow);
  } catch (error) {
    reportExportFailure(error, t("inpainting.export.saveFailed"), runtime, t);
  }
}

async function startPageImageExport({
  currentChapter,
  expectedTargets,
  options,
  runtime,
  selections,
  t,
}: {
  currentChapter: ChapterSnapshot;
  expectedTargets?: PageJobTargetSnapshot[];
  options?: { omitText?: boolean; outputFormat?: PageImageExportFormat };
  runtime: ExportRuntime;
  selections: PageImageExportChapterSelection[];
  t: ReturnType<typeof useTranslation>["t"];
}): Promise<boolean> {
  try {
    const result = await mangaGateway.exportPageImages({
      workId: currentChapter.workId,
      selections,
      expectedTargets,
      ...(options?.omitText ? { omitText: true } : {}),
      ...(options?.outputFormat ? { outputFormat: options.outputFormat } : {}),
    });
    if (!result || result.status === "cancelled") return false;
    runtime.pushStatus(
      result.openError
        ? t("inpainting.export.openFolderFailed", { path: result.outputDir })
        : t(resolveExportSuccessKey(options?.outputFormat), {
            count: result.pageCount,
          }),
    );
    return true;
  } catch (error) {
    reportExportFailure(error, t("inpainting.export.failed"), runtime, t);
  }
}

function resolveExportSuccessKey(
  format: PageImageExportFormat | undefined,
): "inpainting.export.success" | "inpainting.export.successPsd" {
  return format === "psd"
    ? "inpainting.export.successPsd"
    : "inpainting.export.success";
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
