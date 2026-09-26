import type {
  PageWorkflowRequest,
  PageWorkflowResult,
} from "../../shared/pageWorkflowTypes";
import { createPageWorkflowProgress } from "./pageWorkflowProgress";
import { preflightPageWorkflow } from "../../shared/pageWorkflowPolicy";
import { executePageWorkflow } from "../application/pageWorkflowService";
import { getRunPaths, openChapter } from "../library";
import { preparePageWorkflowRun } from "../pageWorkflowRunStore";
import { createPageWorkflowRuntime } from "../pageWorkflow/pageWorkflowRuntime";
import { workflowConfigurationKeys } from "../pageWorkflow/pageWorkflowConfiguration";
import { createDefaultWholePagePipelineDependencies } from "../pipeline/wholePagePipelinePorts";
import { isNonRetriableRuntimeError } from "../pipeline/failure";
import {
  acquireJobPage,
  releaseJobPage,
  reserveJobChapter,
} from "./jobPageOwnership";
import { createJobLifetimeCleanupBoundary } from "./jobLifetimeCleanup";
import { emitJobEvent } from "./jobEvents";
import type { TranslationJobContext } from "./translationJobTypes";
import type { AppPaths } from "../appPaths";
type PageWorkflowJobContext = TranslationJobContext & { appPaths: AppPaths };
import type { AppSettings } from "../../shared/settingsTypes";
import type { JobEvent } from "../../shared/jobTypes";

export async function startPageWorkflowJob(
  context: PageWorkflowJobContext,
  request: PageWorkflowRequest,
  settings: AppSettings,
): Promise<PageWorkflowResult> {
  if (settings.ocr.pipeline !== "hayai")
    throw new Error("페이지 작업은 HayaiOCR에서만 실행할 수 있습니다.");
  const run = await preparePageWorkflowRun(context.appPaths.dataRoot, request);
  const chapters = await Promise.all(
    run.request.selection.map((s) => openChapter(s.chapterId)),
  );
  const preflight = preflightPageWorkflow(run.request, chapters);
  if (preflight.issues.length)
    return {
      runId: run.id,
      status: "failed",
      issues: preflight.issues,
      chapters,
    };
  const abortController = new AbortController();
  const lifetime = createJobLifetimeCleanupBoundary();
  context.jobs.start({
    id: run.id,
    kind: "gemma-analysis",
    abortController,
    cleanup: lifetime.cleanup,
    resources: [
      { kind: "model-runtime", scope: "*", access: "write" },
      ...((run.request.plan.stages.includes("translate") &&
        settings.modelProvider === "openai-codex") ||
      (run.request.plan.stages.includes("erase") &&
        run.request.plan.erasureEngine === "codex")
        ? [{ kind: "codex-auth" as const, scope: "*", access: "read" as const }]
        : []),
    ],
  });
  const emit = (event: JobEvent) =>
    emitJobEvent(context.jobs, context.getMainWindow(), event);
  return context.jobs.run(
    run.id,
    () =>
      runWorkflowJobSafely({
        context,
        run,
        settings,
        abortController,
        lifetime,
        emit,
        chapters,
        preflight,
      }),
    settings,
  );
}

type WorkflowRun = Awaited<ReturnType<typeof preparePageWorkflowRun>>;
async function runWorkflowJob({
  context,
  run,
  settings,
  abortController,
  lifetime,
  emit,
  chapters,
  preflight,
}: {
  context: PageWorkflowJobContext;
  run: WorkflowRun;
  settings: AppSettings;
  abortController: AbortController;
  lifetime: ReturnType<typeof createJobLifetimeCleanupBoundary>;
  emit: (event: JobEvent) => void;
  chapters: Awaited<ReturnType<typeof openChapter>>[];
  preflight: ReturnType<typeof preflightPageWorkflow>;
}) {
  const dependencies = workflowDependencies(context.appPaths, settings);
  const total = preflight.pageCount * run.request.plan.stages.length;
  const progress = createPageWorkflowProgress(run.id, total, emit);
  const runtime = createPageWorkflowRuntime({
    runId: run.id,
    ...run.request,
    rules: run.rules,
    settings,
    paths: context.appPaths,
    signal: abortController.signal,
    emit: progress.emit,
    dependencies,
    runPaths: (chapterId) => getRunPaths(chapterId, run.id),
    decodeImage: context.decodeImage,
  });
  lifetime.registerResourceCleanup(runtime.dispose);
  try {
    for (const chapter of chapters)
      reserveJobChapter(
        context.jobs,
        run.id,
        chapter,
        run.request.selection.find((s) => s.chapterId === chapter.id)
          ?.pageIds ?? [],
        [{ kind: "work-context", scope: chapter.workId, access: "write" }],
      );
    const result = await executePageWorkflow(
      {
        runId: run.id,
        ...run.request,
        signal: abortController.signal,
        configurationKeys: workflowConfigurationKeys(settings),
      },
      {
        ...runtime,
        readChapter: openChapter,
        acquirePage: (chapterId, pageId) =>
          acquireJobPage(context.jobs, run.id, chapterId, pageId, openChapter),
        releasePage: (chapterId, pageId) =>
          releaseJobPage(context.jobs, run.id, chapterId, pageId),
        isFatal: isNonRetriableRuntimeError,
        progress: progress.begin,
      },
    );
    emitWorkflowCompletion(emit, run.id, result, total);
    return result;
  } finally {
    await runtime.dispose();
  }
}

function emitWorkflowCompletion(
  emit: (event: JobEvent) => void,
  id: string,
  result: PageWorkflowResult,
  total: number,
) {
  emit({
    id,
    kind: "gemma-analysis",
    status: result.status === "partial" ? "failed" : result.status,
    phase: "done",
    progressText: result.issues[0]?.message ?? "페이지 작업 완료",
    progressCurrent: total,
    progressTotal: total,
  });
}

async function runWorkflowJobSafely(
  input: Parameters<typeof runWorkflowJob>[0],
) {
  try {
    return await runWorkflowJob(input);
  } catch (error) {
    input.emit({
      id: input.run.id,
      kind: "gemma-analysis",
      status: input.abortController.signal.aborted ? "cancelled" : "failed",
      phase: "failed",
      progressText: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    input.context.jobs.clearIfCurrent(input.run.id);
    input.lifetime.finish();
  }
}

function workflowDependencies(paths: AppPaths, settings: AppSettings) {
  const dependencies = createDefaultWholePagePipelineDependencies(paths);
  dependencies.settings = { getAppSettings: async () => settings };
  return dependencies;
}
