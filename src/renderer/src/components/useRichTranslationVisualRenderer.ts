import React from "react";
import type { TextStyleRun } from "../../../shared/richTextMarkup";
import {
  getRichTextEditorSelection,
  renderRichTextEditorRuns,
  restoreRichTextEditorSelection,
  type RichTextEditorRenderOptions,
  type RichTextEditorSelection,
} from "../lib/richTextEditorDom";
import type { RichTranslationEditorMode } from "./richTranslationEditorTypes";

export type RichTranslationVisualRenderCache = {
  blockId: string;
  committedValue: string | null;
  options: RichTextEditorRenderOptions | null;
  root: HTMLElement | null;
  value: string | null;
};

type VisualRendererArgs = {
  blockId: string;
  mode: RichTranslationEditorMode;
  renderOptions: RichTextEditorRenderOptions;
  runs: readonly TextStyleRun[];
  selectionRef: React.MutableRefObject<RichTextEditorSelection>;
  composingRef: React.MutableRefObject<boolean>;
  compositionEndPendingRef: React.MutableRefObject<boolean>;
  value: string;
};

type RichTranslationVisualRenderer = {
  cacheRef: React.MutableRefObject<RichTranslationVisualRenderCache>;
  visualRef: React.MutableRefObject<HTMLDivElement | null>;
};

export function useRichTranslationVisualRenderer(
  args: VisualRendererArgs,
): RichTranslationVisualRenderer {
  const visualRef = React.useRef<HTMLDivElement | null>(null);
  const cacheRef = React.useRef<RichTranslationVisualRenderCache>({
    blockId: args.blockId,
    committedValue: args.value,
    options: null,
    root: null,
    value: null,
  });
  React.useLayoutEffect(() => {
    synchronizeVisualEditor(args, visualRef.current, cacheRef);
  }, [args, cacheRef, visualRef]);
  return { cacheRef, visualRef };
}

export function renderAndCacheRichTranslationRuns(
  root: HTMLElement,
  runs: readonly TextStyleRun[],
  options: RichTextEditorRenderOptions,
  selection: RichTextEditorSelection | null,
  value: string,
  cacheRef: React.MutableRefObject<RichTranslationVisualRenderCache>,
): void {
  renderRichTextEditorRuns(root, runs, options, selection);
  cacheRef.current = {
    ...cacheRef.current,
    options,
    root,
    value,
    committedValue: value,
  };
}

function synchronizeVisualEditor(
  args: VisualRendererArgs,
  root: HTMLDivElement | null,
  cacheRef: React.MutableRefObject<RichTranslationVisualRenderCache>,
): void {
  if (!root || args.mode !== "visual") return;
  if (args.composingRef.current || args.compositionEndPendingRef.current) {
    return;
  }
  const cache = cacheRef.current;
  const switchedBlock = cache.blockId !== args.blockId;
  cache.blockId = args.blockId;
  if (isVisualRenderCurrent(args, root, cache, switchedBlock)) return;
  const activeElement = root.ownerDocument.activeElement;
  const activeSelection = resolveActiveVisualSelection(
    root,
    activeElement,
    switchedBlock,
  );
  const savedSelection = args.selectionRef.current;
  renderAndCacheRichTranslationRuns(
    root,
    args.runs,
    args.renderOptions,
    shouldShowSavedSelection(root, activeElement, savedSelection)
      ? savedSelection
      : null,
    args.value,
    cacheRef,
  );
  if (activeSelection) restoreRichTextEditorSelection(root, activeSelection);
}

function isVisualRenderCurrent(
  args: VisualRendererArgs,
  root: HTMLElement,
  cache: RichTranslationVisualRenderCache,
  switchedBlock: boolean,
): boolean {
  return (
    !switchedBlock &&
    cache.value === args.value &&
    cache.options === args.renderOptions &&
    cache.root === root
  );
}

function resolveActiveVisualSelection(
  root: HTMLElement,
  activeElement: Element | null,
  switchedBlock: boolean,
): RichTextEditorSelection | null {
  return !switchedBlock && root.contains(activeElement)
    ? getRichTextEditorSelection(root)
    : null;
}

function shouldShowSavedSelection(
  root: HTMLElement,
  activeElement: Element | null,
  selection: RichTextEditorSelection,
): boolean {
  const editor = root.closest(".rich-translation-editor");
  return Boolean(
    editor?.contains(activeElement) &&
    !root.contains(activeElement) &&
    selection.end > selection.start,
  );
}
