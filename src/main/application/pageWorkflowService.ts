import type { MangaPage, ChapterSnapshot } from "../../shared/libraryTypes";
import { PageWorkflowPartialFailure } from "./pageWorkflowPartialFailure";
import {
  workflowReceipt,
  workflowStageComplete,
  completeWorkflowReceipt,
  failWorkflowReceipt,
} from "./pageWorkflowReceipts";
import {
  type PageWorkflowPlan,
  type PageWorkflowResult,
  type PageWorkflowIssue,
} from "../../shared/pageWorkflowTypes";
import {
  PAGE_WORKFLOW_STAGES,
  type PageWorkflowStage,
} from "../../shared/pageWorkflowStages";

export type PageWorkflowExecutionPort = {
  restoreCompletedStage?: (
    stage: PageWorkflowStage,
    page: MangaPage,
  ) => Promise<void>;
  readChapter: (chapterId: string) => Promise<ChapterSnapshot>;
  acquirePage: (chapterId: string, pageId: string) => Promise<MangaPage>;
  releasePage: (chapterId: string, pageId: string) => void;
  save: (
    chapterId: string,
    before: MangaPage,
    after: MangaPage,
  ) => Promise<void>;
  prepareStage: (
    stage: PageWorkflowStage,
    chapter: ChapterSnapshot,
    pageIds: string[],
  ) => Promise<void>;
  execute: (
    stage: PageWorkflowStage,
    chapter: ChapterSnapshot,
    page: MangaPage,
  ) => Promise<MangaPage>;
  progress: (stage: PageWorkflowStage, page: MangaPage) => void;
  isFatal: (error: unknown) => boolean;
};
export type PageWorkflowExecution = {
  configurationKeys?: Partial<Record<PageWorkflowStage, string>>;
  runId: string;
  plan: PageWorkflowPlan;
  selection: Array<{ chapterId: string; pageIds: string[] }>;
  signal: AbortSignal;
};

export async function executePageWorkflow(
  input: PageWorkflowExecution,
  port: PageWorkflowExecutionPort,
): Promise<PageWorkflowResult> {
  const issues: PageWorkflowIssue[] = [];
  try {
    for (const selection of input.selection) {
      issues.push(...(await executeWorkflowChapter(input, port, selection)));
    }
  } catch (error) {
    if (!input.signal.aborted)
      issues.push({
        chapterId: "",
        message: error instanceof Error ? error.message : String(error),
      });
  }
  return {
    runId: input.runId,
    status: input.signal.aborted
      ? "cancelled"
      : issues.some((issue) => !issue.pageId)
        ? "failed"
        : issues.length
          ? "partial"
          : "completed",
    chapters: await Promise.all(
      input.selection.map((item) => port.readChapter(item.chapterId)),
    ),
    issues,
  };
}

async function executeWorkflowChapter(
  input: PageWorkflowExecution,
  port: PageWorkflowExecutionPort,
  selection: PageWorkflowExecution["selection"][number],
) {
  const acquired: string[] = [];
  const issues: PageWorkflowIssue[] = [];
  try {
    for (const id of selection.pageIds) {
      await port.acquirePage(selection.chapterId, id);
      acquired.push(id);
    }
    for (const stage of PAGE_WORKFLOW_STAGES.filter((id) =>
      input.plan.stages.includes(id),
    )) {
      input.signal.throwIfAborted();
      const chapter = await port.readChapter(selection.chapterId);
      const pageIds = chapter.pages
        .map((page) => page.id)
        .filter(
          (id) =>
            acquired.includes(id) && !hasFailedDependency(issues, id, stage),
        );
      await port.prepareStage(stage, chapter, pageIds);
      const stageIssues = await executeWorkflowPages(
        input,
        port,
        chapter,
        pageIds,
        stage,
      );
      issues.push(...stageIssues);
    }
    return issues;
  } finally {
    for (const id of acquired) port.releasePage(selection.chapterId, id);
  }
}

function hasFailedDependency(
  issues: PageWorkflowIssue[],
  pageId: string,
  stage: PageWorkflowStage,
) {
  return issues.some((issue) => {
    if (issue.pageId !== pageId) return false;
    // Standalone erasure is independent; a combined run must not erase after
    // its translation stage failed or left untranslated slots.
    if (stage === "erase")
      return (
        issue.stage === "detect" ||
        issue.stage === "translate" ||
        issue.stage === "format-rules"
      );
    // Text review does not depend on a successfully generated clean background.
    if (stage === "review" && issue.stage === "erase") return false;
    return true;
  });
}

async function executeWorkflowPage(
  input: PageWorkflowExecution,
  port: PageWorkflowExecutionPort,
  chapter: ChapterSnapshot,
  pageId: string,
  stage: PageWorkflowStage,
): Promise<PageWorkflowIssue | undefined> {
  const current = await port.readChapter(chapter.id);
  const before = current.pages.find((page) => page.id === pageId);
  if (!before) throw new Error("작업 대상 페이지가 사라졌습니다.");
  const receipt = workflowReceipt(input, before);
  if (
    workflowStageComplete(
      receipt,
      before,
      stage,
      input.configurationKeys?.[stage],
    )
  ) {
    await port.restoreCompletedStage?.(stage, before);
    return;
  }
  let after: MangaPage;
  try {
    port.progress(stage, before);
    after = await port.execute(stage, current, before);
    input.signal.throwIfAborted();
  } catch (error) {
    if (input.signal.aborted || port.isFatal(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const partial =
      error instanceof PageWorkflowPartialFailure ? error.page : before;
    await port.save(
      chapter.id,
      before,
      failWorkflowReceipt(receipt, before, partial, stage, message),
    );
    return { chapterId: chapter.id, pageId, stage, message };
  }
  await port.save(
    chapter.id,
    before,
    completeWorkflowReceipt(
      receipt,
      before,
      after,
      stage,
      input.configurationKeys?.[stage],
    ),
  );
}

async function executeWorkflowPages(
  input: PageWorkflowExecution,
  port: PageWorkflowExecutionPort,
  chapter: ChapterSnapshot,
  pageIds: string[],
  stage: PageWorkflowStage,
) {
  const issues: PageWorkflowIssue[] = [];
  for (const pageId of pageIds) {
    input.signal.throwIfAborted();
    const issue = await executeWorkflowPage(
      input,
      port,
      chapter,
      pageId,
      stage,
    );
    if (issue) issues.push(issue);
  }
  return issues;
}
