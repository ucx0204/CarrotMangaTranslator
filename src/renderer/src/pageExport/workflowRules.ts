import {
  createConditionalBatchPreview,
  applyConditionalBatchPreview,
} from "../../../shared/conditionalBatchEngine";
import type {
  PageWorkflowRuleRenderRequest,
  PageWorkflowRuleRenderResult,
} from "../../../shared/pageWorkflowTypes";
import {
  createConditionalBatchFontSizeResolver,
  createConditionalBatchTypographyLoadKey,
} from "../lib/conditionalBatchTypography";
import { loadBlockFontsForKey } from "../lib/blockFontLoading";
import type { BlockFontCatalog } from "../lib/fonts";

export function installWorkflowRuleRenderer(catalog: BlockFontCatalog): void {
  Object.assign(window, {
    applyWorkflowRules: async (
      request: PageWorkflowRuleRenderRequest,
    ): Promise<PageWorkflowRuleRenderResult> => {
      let chapter = request.chapter;
      const findings: PageWorkflowRuleRenderResult["findings"] = [];
      for (const scheme of request.schemes) {
        const key = createConditionalBatchTypographyLoadKey(
          chapter,
          [scheme],
          catalog,
        );
        const report = await loadBlockFontsForKey(document, key);
        if (report.failures.length || report.missingFamilies.length)
          throw new Error("일괄 편집에 필요한 글꼴을 불러오지 못했습니다.");
        const options = {
          glossary: request.glossary,
          resolveFontSizePx: createConditionalBatchFontSizeResolver(catalog),
        };
        const preview = createConditionalBatchPreview(
          chapter,
          { kind: "page", pageId: request.pageId },
          scheme,
          options,
        );
        if (request.inspect)
          findings.push(
            ...preview.results.map((row) => ({
              blockId: row.blockId,
              rule: scheme.name,
            })),
          );
        else {
          const result = applyConditionalBatchPreview(
            chapter,
            scheme,
            preview,
            new Set(),
            undefined,
            options,
          );
          if (result.conflictCount)
            throw new Error("일괄 편집 입력이 변경되었습니다.");
          chapter = result.chapter;
        }
      }
      return { chapter, findings };
    },
  });
}
