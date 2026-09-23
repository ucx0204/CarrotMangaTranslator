import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import { workflowTargetBlocks } from "../../shared/pageWorkflowPolicy";
import { runWholePagePipeline } from "../wholePagePipeline";
import { resolveWorkContextForChapter } from "../library";
import { buildKeepBlocksOcrResult } from "../pipeline/keepBlocksResult";
import type { PageWorkflowRuntimeContext } from "./pageWorkflowRuntimeTypes";

export async function translateWorkflowPage(
  context: PageWorkflowRuntimeContext,
  chapter: ChapterSnapshot,
  page: MangaPage,
  readContext: typeof resolveWorkContextForChapter = resolveWorkContextForChapter,
): Promise<MangaPage> {
  assertWorkflowSource(page, context);
  const blocks = workflowTargetBlocks(page, "translate", context.plan);
  if (!blocks.length)
    return { ...page, analysisStatus: "completed", lastError: undefined };
  // Use the existing kept-block contract: accepted output updates its slot;
  // omitted or filtered output preserves that slot for optional review.
  const input = { ...page, blocks };
  const workContext = await readContext(chapter.id);
  const result = await runWholePagePipeline(
    {
      jobId: context.runId,
      pages: [input],
      runPaths: await context.runPaths(chapter.id),
      signal: context.signal,
      emit: (event) =>
        context.emit(
          event.phase === "page_done"
            ? {
                ...event,
                phase: "page_running",
                progressText: `${page.name} 번역 결과 확인 중`,
              }
            : event,
        ),
      blockMode: "keep",
      preparedOcrHints: new Map([
        [
          page.id,
          buildKeepBlocksOcrResult(
            input,
            blocks.map((block) => block.sourceText),
          ),
        ],
      ]),
      autoFontMatching: false,
      aiFontSizeMatching: false,
      naturalTextLayout: false,
      collectPageContext: context.plan.cumulative,
      cumulativeContextDetail: context.plan.cumulativeDetail,
      workContext: {
        ...workContext,
        chapterId: chapter.id,
        recentPageCount: 6,
        previousStoryPages: context.previousStoryPages,
      },
      canonicalPageIndexById: new Map(
        chapter.pages.map((item, index) => [item.id, index]),
      ),
      decodeImage: context.decodeImage,
    },
    context.dependencies,
  );
  const translated = result.pages[0];
  if (!translated || translated.analysisStatus === "failed")
    throw new Error(
      translated?.lastError ??
        (result.warnings.join("\n") || "번역 결과를 받지 못했습니다."),
    );
  return mergeWorkflowTranslations(page, blocks, translated);
}

function mergeWorkflowTranslations(
  page: MangaPage,
  targets: MangaPage["blocks"],
  translated: MangaPage,
): MangaPage {
  const targetIds = new Set(targets.map((block) => block.id));
  const outputs = new Map(
    translated.blocks
      .filter((block) => targetIds.has(block.id) && block.translatedText.trim())
      .map((block) => [block.id, block]),
  );
  return {
    ...page,
    analysisStatus: "completed",
    lastError: undefined,
    blocks: page.blocks.map((block) => {
      const output = outputs.get(block.id);
      return output
        ? {
            ...block,
            translatedText: output.translatedText,
            fontRole: block.fontRole ?? output.fontRole,
            fontRoleConfidence:
              block.fontRoleConfidence ?? output.fontRoleConfidence,
            visualClusterId: block.visualClusterId ?? output.visualClusterId,
          }
        : block;
    }),
  };
}

function assertWorkflowSource(
  page: MangaPage,
  context: PageWorkflowRuntimeContext,
) {
  const missingSource = page.blocks.some(
    (block) =>
      !block.sourceText.trim() &&
      (context.plan.overwrite.includes("translate") ||
        !block.translatedText.trim()),
  );
  if (missingSource)
    throw new Error(
      "원문이 비어 있는 블록이 있습니다. 원문을 확인한 뒤 이어서 실행하세요.",
    );
}
