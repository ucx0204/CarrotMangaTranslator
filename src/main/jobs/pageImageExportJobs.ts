import { randomUUID } from "node:crypto";
import type {
  PageImageExportRequest,
  PageImageExportResult,
  PagePsdExportRequest,
  PageExportSelectionRequest,
} from "../../shared/pageImageExportTypes";
import type { JobEvent } from "../../shared/jobTypes";
import { tMain } from "./localization";
import {
  handlePageImageExportError,
  runPageImageExportJob,
} from "./pageImageExportJobRunner";
import {
  productionPageImageExportDependencies,
  type PageImageExportDependencies,
} from "./pageImageExportPorts";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
import { emitJobEvent } from "./jobEvents";
import { createJobLifetimeCleanupBoundary } from "./jobLifetimeCleanup";

export async function exportPageImages(
  context: InpaintingJobContext,
  request: PageImageExportRequest,
  outputParentDir: string,
  dependencies: PageImageExportDependencies = productionPageImageExportDependencies,
): Promise<PageImageExportResult> {
  return exportPageSelection(context, request, outputParentDir, dependencies);
}

export async function exportPagePsd(
  context: InpaintingJobContext,
  request: PagePsdExportRequest,
  outputParentDir: string,
  dependencies: PageImageExportDependencies = productionPageImageExportDependencies,
): Promise<PageImageExportResult> {
  return exportPageSelection(
    context,
    { ...request, outputFormat: "psd" },
    outputParentDir,
    dependencies,
  );
}

async function exportPageSelection(
  context: InpaintingJobContext,
  request: PageExportSelectionRequest,
  outputParentDir: string,
  dependencies: PageImageExportDependencies,
): Promise<PageImageExportResult> {
  assertNoActiveJob(context);

  const id = randomUUID();
  const abortController = new AbortController();
  const lifetime = createJobLifetimeCleanupBoundary();
  context.jobs.start({
    id,
    kind: "page-export",
    abortController,
    cleanup: lifetime.cleanup,
  });
  const emit = (event: JobEvent) =>
    emitJobEvent(context.jobs, context.getMainWindow(), event);

  try {
    return await runPageImageExportJob({
      context,
      request,
      outputParentDir,
      id,
      abortController,
      emit,
      dependencies,
    });
  } catch (error) {
    return handlePageImageExportError({
      abortController,
      emit,
      error,
      id,
      request,
      dependencies,
    });
  } finally {
    try {
      context.jobs.clearIfCurrent(id);
    } finally {
      lifetime.finish();
    }
  }
}

export function assertNoActivePageImageExportJob(
  context: Pick<InpaintingJobContext, "jobs">,
): void {
  assertNoActiveJob(context);
}

function assertNoActiveJob(context: Pick<InpaintingJobContext, "jobs">): void {
  if (context.jobs.hasActive) {
    throw new Error(tMain("jobs.active"));
  }
}
