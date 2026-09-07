import { markFailedRegions } from "./codexTypesettingFallback";
import type { CodexPageReading } from "../../shared/codexTypesettingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { createWarpPreset } from "../../shared/warpTransformMath";
import { createCurvePreset } from "../../shared/blockTransformPresets";
import type {
  CodexChapterPlan,
  TypesettingLayout,
  TypesettingIssue,
} from "./codexTypesettingContracts";
import { assertExactMembership } from "./codexTypesettingValidation";
import { serializeCodexLayoutText } from "./codexTypesettingTreatment";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../../shared/blockFormat";

/** Keep recognized text editable for failed erasures, without painting over the remaining source. */
export function withBlockedCodexLettering(
  page: MangaPage,
  reading: CodexPageReading,
  blockedIds: string[],
  blockId: (id: string) => string,
): MangaPage {
  const markers: TranslationBlock[] = reading.regions
    .filter((region) => blockedIds.includes(region.id))
    .map((region) => ({
      ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
      id: blockId(region.id),
      type: "nonsolid",
      bbox: region.sourceBbox,
      bboxSpace: "normalized_1000",
      sourceText: region.sourceText,
      translatedText: region.translatedText,
      confidence: 1,
      sourceDirection: region.direction,
      renderDirection: "horizontal",
      backgroundColor: "#ffffff",
      opacity: 0,
      textOpacity: 0,
      inpaintExcluded: true,
      layoutIntentSuppressed: true,
      reviewStatus: "needs_review",
      reviewNote: "원문 제거 실패로 번역 이미지 생성을 중단했습니다.",
    }));
  const blocks = [...page.blocks, ...markers];
  return { ...page, blocks, blockOrder: blocks.map((block) => block.id) };
}

/** Keep the first generated pixels and annotate only the affected blocks. */
export function withCodexTypesettingReview(
  result: { page: MangaPage; warning?: string },
  issues: TypesettingIssue[],
  blockId: (id: string) => string,
): { page: MangaPage; warning?: string } {
  if (!issues.length) return result;
  const ids = [...new Set(issues.map((issue) => issue.regionId))];
  let page = result.page;
  for (const id of ids) {
    const reason = issues
      .filter((issue) => issue.regionId === id)
      .map((issue) => issue.reason)
      .join("\n");
    page = markFailedRegions(page, [id], blockId, reason);
  }
  return {
    page,
    warning: [
      result.warning,
      `${page.name}: ${ids.length}개 영역에 확인할 문제가 있습니다.`,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/** Review-only markers have no invented transcript, erasure or visible overlay. */
export function withCodexReadingReview(
  result: { page: MangaPage; warning?: string },
  reading: CodexPageReading,
  blockId: (id: string) => string,
): { page: MangaPage; warning?: string } {
  const preserved = reading.regions.filter(
    (region) => region.action === "keep" && region.preserveReason,
  );
  if (!preserved.length) return result;
  const defaults = DEFAULT_BLOCK_FORMAT_DEFAULTS;
  const markers = preserved.map(
    (region): TranslationBlock => ({
      id: blockId(region.id),
      type: "nonsolid",
      bbox: region.sourceBbox,
      bboxSpace: "normalized_1000",
      renderBbox: region.sourceBbox,
      renderBboxSpace: "normalized_1000",
      sourceText: "",
      translatedText: "",
      confidence: 0,
      sourceDirection: region.direction,
      renderDirection: "horizontal",
      fontSizePx: defaults.fontSizePx,
      lineHeight: defaults.lineHeight,
      textAlign: defaults.textAlign,
      textColor: defaults.textColor,
      backgroundColor: defaults.outlineColor,
      opacity: 0,
      textOpacity: 0,
      inpaintExcluded: true,
      layoutIntentSuppressed: true,
      reviewStatus: "needs_review",
      reviewNote: `원문 판독 보류: ${region.preserveReason}`,
    }),
  );
  const blocks = [...result.page.blocks, ...markers];
  return {
    page: {
      ...result.page,
      blocks,
      blockOrder: blocks.map((block) => block.id),
    },
    warning: [
      result.warning,
      `${result.page.name}: 판독하지 못한 ${markers.length}개 영역은 원문을 보존하고 검토 대상으로 표시했습니다.`,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export function buildCodexTypesetPage(
  page: MangaPage,
  reading: CodexPageReading,
  plan: CodexChapterPlan,
  layouts: TypesettingLayout[],
  blockId: (id: string) => string,
): MangaPage {
  const regions = reading.regions.filter((region) => region.action !== "keep");
  assertExactMembership(
    regions.map((region) => region.id),
    layouts.map((layout) => layout.regionId),
    "Page layout",
  );
  const blocks = regions.map((region): TranslationBlock => {
    const layout = layouts.find((item) => item.regionId === region.id);
    const group = plan.groups.find((item) =>
      item.members.some((member) => member.regionId === region.id),
    );
    const member = group?.members.find((item) => item.regionId === region.id);
    const font = plan.fonts.find((item) => item.groupId === group?.id);
    if (!layout || !group || !member || !font)
      throw new Error(`식자 계획에 영역이 없습니다: ${region.id}`);
    return {
      id: blockId(region.id),
      type: "nonsolid",
      bbox: region.sourceBbox,
      bboxSpace: "normalized_1000",
      renderBbox: layout.renderBbox,
      renderBboxSpace: "normalized_1000",
      sourceText: region.sourceText,
      translatedText: serializeCodexLayoutText(layout),
      textRole: region.role,
      visualClusterId: group.id,
      confidence: 1,
      sourceDirection: region.direction,
      renderDirection: layout.direction,
      layoutIntentSuppressed: true,
      fontFamily: font.fontId,
      fontSizePx: layout.fontSizePx,
      fontSizeIntent: "manual",
      bold: layout.runs?.length ? false : (layout.bold ?? member.bold),
      italic: layout.runs?.length ? false : (layout.italic ?? member.italic),
      rotationDeg: layout.rotationDeg,
      lineHeight: layout.lineHeight,
      textColor: layout.textColor,
      textAlign: layout.textAlign,
      outlineColor: layout.outlineColor,
      outlineWidthPx: layout.outlineWidthPx,
      wordBreak: "keep-all-overflow",
      backgroundColor: "#ffffff",
      opacity: 0,
      autoFitText: false,
      reviewStatus: "draft",
      ...editableEffects(layout, region.action),
    };
  });
  return {
    ...page,
    blocks,
    blockOrder: blocks.map((block) => block.id),
    analysisStatus: "completed",
    typesettingMethod: "codex",
  };
}

function editableEffects(
  layout: TypesettingLayout,
  action: string,
): Partial<TranslationBlock> {
  if (action !== "text") return {};
  return {
    ...(layout.warpPreset && layout.warpPreset !== "none"
      ? { warpTransform: createWarpPreset(layout.warpPreset) }
      : {}),
    ...(layout.curvePreset && layout.curvePreset !== "none"
      ? { curveLayout: createCurvePreset(layout.curvePreset) }
      : {}),
  };
}
