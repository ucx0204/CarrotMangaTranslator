import { isUsableBubbleLayout } from "../../shared/bubbleLayout";
import type { MangaPage } from "../../shared/libraryTypes";
import { applyNaturalTextLayout } from "../../shared/naturalTextLayout";
import {
  captureInpaintingLayoutStates,
  inpaintingLayoutStatesEqual,
  type InpaintingBlockLayoutState,
} from "./inpaintingLayoutState";

export type BubbleNaturalTextLayoutConfig = {
  locale?: string;
};

export function applyBubbleNaturalTextLayout(
  page: MangaPage,
  config: BubbleNaturalTextLayoutConfig | undefined,
  blockId?: string,
): MangaPage {
  if (!config) {
    return page;
  }
  let changed = false;
  const blocks = page.blocks.map((block) => {
    if (
      (blockId && block.id !== blockId) ||
      block.curveLayout ||
      !isUsableBubbleLayout(block.bubbleLayout)
    ) {
      return block;
    }
    const layout = applyNaturalTextLayout(block, {
      enabled: true,
      pageSize: { width: page.width, height: page.height },
      locale: config.locale,
      allowAutoVertical: false,
      directionPreference: block.renderDirection,
    });
    if (
      layout.diagnostics.shapeAware !== true ||
      layout.translatedText === block.translatedText
    ) {
      return block;
    }
    changed = true;
    return { ...block, translatedText: layout.translatedText };
  });
  return changed ? { ...page, blocks } : page;
}

export function collectBubbleLayoutChanges(
  beforePage: MangaPage,
  afterPage: MangaPage,
  geometryBlockIds: readonly string[],
): {
  beforeLayout: InpaintingBlockLayoutState[];
  afterLayout: InpaintingBlockLayoutState[];
} {
  const beforeLayout: InpaintingBlockLayoutState[] = [];
  const afterLayout: InpaintingBlockLayoutState[] = [];
  for (const blockId of resolveChangedBlockIds(
    beforePage,
    afterPage,
    geometryBlockIds,
  )) {
    const beforeBlock = beforePage.blocks.find((block) => block.id === blockId);
    const afterBlock = afterPage.blocks.find((block) => block.id === blockId);
    if (!beforeBlock || !afterBlock) {
      throw missingBlockError();
    }
    const includeText =
      beforeBlock.translatedText !== afterBlock.translatedText;
    const before = captureLayoutState(beforePage, blockId, includeText);
    const after = captureLayoutState(afterPage, blockId, includeText);
    if (!inpaintingLayoutStatesEqual([before], [after])) {
      beforeLayout.push(before);
      afterLayout.push(after);
    }
  }
  return { beforeLayout, afterLayout };
}

function resolveChangedBlockIds(
  beforePage: MangaPage,
  afterPage: MangaPage,
  geometryBlockIds: readonly string[],
): string[] {
  const ids = new Set(geometryBlockIds);
  const beforeById = new Map(
    beforePage.blocks.map((block) => [block.id, block]),
  );
  for (const block of afterPage.blocks) {
    if (beforeById.get(block.id)?.translatedText !== block.translatedText) {
      ids.add(block.id);
    }
  }
  return [...ids];
}

function captureLayoutState(
  page: MangaPage,
  blockId: string,
  includeTranslatedText: boolean,
): InpaintingBlockLayoutState {
  const state = captureInpaintingLayoutStates(
    page,
    [blockId],
    includeTranslatedText ? { includeTranslatedText: true } : undefined,
  )[0];
  if (!state) {
    throw missingBlockError();
  }
  return state;
}

function missingBlockError(): Error {
  return new Error("말풍선 배치를 적용할 텍스트 블록을 찾지 못했습니다.");
}
