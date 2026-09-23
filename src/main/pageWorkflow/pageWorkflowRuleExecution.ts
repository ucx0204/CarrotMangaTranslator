import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { PageWorkflowRuleStage } from "../../shared/pageWorkflowTypes";
import {
  createConditionalBatchRecipeDraft,
  type ConditionalBatchRecipeId,
} from "../../shared/conditionalBatchRules";
import { resolveWorkContextForChapter } from "../library";
import { createPageExportRenderSession } from "../pageExport";
import type { PageWorkflowRuntimeContext } from "./pageWorkflowRuntimeTypes";

const REVIEW_RULES: ConditionalBatchRecipeId[] = [
  "emptyTranslation",
  "sameAsSource",
  "numberMismatch",
  "unbalancedPunctuation",
  "suspiciousWhitespace",
  "glossaryMismatch",
];

export async function applyWorkflowRuleStage(
  context: PageWorkflowRuntimeContext,
  chapter: ChapterSnapshot,
  page: MangaPage,
  stage: PageWorkflowRuleStage | "review",
): Promise<MangaPage> {
  if (!page.blocks.length) return page;
  const schemes =
    stage === "review"
      ? REVIEW_RULES.filter(
          (id) =>
            id !== "emptyTranslation" ||
            context.plan.stages.includes("translate"),
        ).map((id) => createConditionalBatchRecipeDraft(id))
      : (context.rules[stage] ?? []);
  if (!schemes.length) return page;
  const session = await createPageExportRenderSession({
    dataRoot: context.paths.dataRoot,
    decodeFallback: context.decodeImage,
    lowPriority: true,
  });
  const cancel = () => session.cancel?.();
  context.signal.addEventListener("abort", cancel, { once: true });
  try {
    context.signal.throwIfAborted();
    await session.renderPage(page);
    if (!session.applyWorkflowRules)
      throw new Error("일괄 편집 계측기를 사용할 수 없습니다.");
    const work = await resolveWorkContextForChapter(chapter.id);
    const result = await session.applyWorkflowRules({
      chapter: {
        ...chapter,
        pages: chapter.pages.map((entry) =>
          entry.id === page.id ? page : entry,
        ),
      },
      pageId: page.id,
      schemes,
      glossary: work.styleGuide.glossary,
      inspect: stage === "review",
    });
    const output = result.chapter.pages.find((entry) => entry.id === page.id);
    if (!output) throw new Error("일괄 편집 결과에 대상 페이지가 없습니다.");
    if (stage !== "review") return output;
    return {
      ...output,
      pageWorkflow: {
        runId: context.runId,
        planKey: "",
        steps: {},
        findings: result.findings,
      },
    };
  } finally {
    context.signal.removeEventListener("abort", cancel);
    session.close();
  }
}
