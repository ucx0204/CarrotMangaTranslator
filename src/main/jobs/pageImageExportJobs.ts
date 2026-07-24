import { randomUUID } from "node:crypto";
import type {
  PageImageExportRequest,
  PageImageExportResult,
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

export async function exportPageImages(
  context: InpaintingJobContext,
  request: PageImageExportRequest,
  outputParentDir: string,
  dependencies: PageImageExportDependencies = productionPageImageExportDependencies,
): Promise<PageImageExportResult> {
  assertNoActiveJob(context);

  const id = randomUUID();
  const abortController = new AbortController();
  context.jobs.start({ id, kind: "page-export", abortController });
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
    context.jobs.clearIfCurrent(id);
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
