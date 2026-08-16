import {
  mergeTextStyleRuns,
  type TextStyleRun,
} from "../../../shared/richTextMarkup";

const RUN_ATTRIBUTE = "data-rich-text-run";
const SELECTION_ATTRIBUTE = "data-rich-text-selection";
const BLOCK_ELEMENTS = new Set(["DIV", "P", "LI"]);

export type RichTextEditorRenderOptions = {
  baseBold: boolean;
  baseItalic: boolean;
  baseFontSizePx: number;
  baseFontFamily: string;
  baseOpacity: number;
  resolveFontFamily: (fontId: string | undefined) => string;
};

export type RichTextEditorSelection = {
  start: number;
  end: number;
};

export function renderRichTextEditorRuns(
  root: HTMLElement,
  runs: readonly TextStyleRun[],
  options: RichTextEditorRenderOptions,
  previewSelection?: RichTextEditorSelection | null,
): void {
  const fragment = root.ownerDocument.createDocumentFragment();
  const baseSize = Math.max(1, options.baseFontSizePx);
  let plainOffset = 0;
  for (const run of runs) {
    if (!run.text) continue;
    const boundaries = runBoundaries(
      run.text.length,
      plainOffset,
      previewSelection,
    );
    for (let index = 1; index < boundaries.length; index += 1) {
      const segmentStart = boundaries[index - 1] ?? 0;
      const segmentEnd = boundaries[index] ?? run.text.length;
      const text = run.text.slice(segmentStart, segmentEnd);
      if (!text) continue;
      const span = createRunSpan(root, run, options, baseSize, text);
      const absoluteStart = plainOffset + segmentStart;
      const absoluteEnd = plainOffset + segmentEnd;
      if (
        previewSelection &&
        previewSelection.end > previewSelection.start &&
        absoluteStart < previewSelection.end &&
        absoluteEnd > previewSelection.start
      ) {
        span.setAttribute(SELECTION_ATTRIBUTE, "");
      }
      fragment.append(span);
    }
    plainOffset += run.text.length;
  }
  if (!fragment.hasChildNodes()) {
    const placeholder = root.ownerDocument.createElement("br");
    placeholder.dataset.richTextPlaceholder = "";
    fragment.append(placeholder);
  }
  root.replaceChildren(fragment);
}

export function clearRichTextEditorSelectionPreview(root: ParentNode): void {
  root
    .querySelectorAll(`[${SELECTION_ATTRIBUTE}]`)
    .forEach((element) => element.removeAttribute(SELECTION_ATTRIBUTE));
}

export function extractRichTextEditorRuns(root: ParentNode): TextStyleRun[] {
  const runs: TextStyleRun[] = [];
  const append = (text: string, style: Omit<TextStyleRun, "text">): void => {
    if (!text) return;
    runs.push({ text, ...style });
  };

  // eslint-disable-next-line complexity -- browser contenteditable nodes are normalized in one depth-first traversal
  const visit = (node: Node, inherited: Omit<TextStyleRun, "text">): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.nodeValue ?? "", inherited);
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === "BR") {
      if (!node.hasAttribute("data-rich-text-placeholder")) {
        append("\n", inherited);
      }
      return;
    }

    const style = node.hasAttribute(RUN_ATTRIBUTE)
      ? readRunStyle(node as HTMLElement)
      : inherited;
    const isBlock = BLOCK_ELEMENTS.has(node.tagName);
    if (isBlock && textLength(runs) > 0 && !endsWithNewline(runs)) {
      append("\n", style);
    }
    node.childNodes.forEach((child) => visit(child, style));
    if (isBlock && node.nextSibling && !endsWithNewline(runs)) {
      append("\n", style);
    }
  };

  root.childNodes.forEach((child) =>
    visit(child, { bold: false, italic: false }),
  );
  return mergeTextStyleRuns(runs);
}

export function getRichTextEditorSelection(
  root: HTMLElement,
): RichTextEditorSelection | null {
  const selection = root.ownerDocument.getSelection();
  if (
    !selection ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !root.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  ) {
    return null;
  }
  const anchor = resolvePlainOffset(
    root,
    selection.anchorNode,
    selection.anchorOffset,
  );
  const focus = resolvePlainOffset(
    root,
    selection.focusNode,
    selection.focusOffset,
  );
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

// eslint-disable-next-line complexity -- caret ownership is validated fail-closed before resolving the active style run
export function getRichTextEditorCaretRun(
  root: HTMLElement,
): TextStyleRun | null {
  const selection = root.ownerDocument.getSelection();
  if (
    !selection ||
    !selection.isCollapsed ||
    !selection.focusNode ||
    !root.contains(selection.focusNode)
  ) {
    return null;
  }
  let targetNode: Node | null = selection.focusNode;
  if (targetNode === root) {
    targetNode =
      root.childNodes[Math.max(0, selection.focusOffset - 1)] ??
      root.childNodes[selection.focusOffset] ??
      null;
  }
  const element =
    targetNode instanceof Element ? targetNode : targetNode?.parentElement;
  const runElement = element?.closest<HTMLElement>(`[${RUN_ATTRIBUTE}]`);
  if (!runElement || !root.contains(runElement)) return null;
  return { text: "", ...readRunStyle(runElement) };
}

export function restoreRichTextEditorSelection(
  root: HTMLElement,
  selection: RichTextEditorSelection,
): void {
  const document = root.ownerDocument;
  const nativeSelection = document.getSelection();
  if (!nativeSelection) return;
  const start = findTextPosition(root, selection.start);
  const end = findTextPosition(root, selection.end);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  nativeSelection.removeAllRanges();
  nativeSelection.addRange(range);
}

export function insertPlainTextAtEditorSelection(
  root: HTMLElement,
  text: string,
): boolean {
  const selection = root.ownerDocument.getSelection();
  if (
    !selection ||
    selection.rangeCount === 0 ||
    !selection.anchorNode ||
    !root.contains(selection.anchorNode)
  ) {
    return false;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = root.ownerDocument.createTextNode(text.replace(/\r\n?/g, "\n"));
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function resolvePlainOffset(
  root: HTMLElement,
  node: Node,
  offset: number,
): number {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(node, offset);
  } catch (error) {
    void error;
    return extractRichTextEditorRuns(root)
      .map((run) => run.text)
      .join("").length;
  }
  const wrapper = root.ownerDocument.createElement("div");
  wrapper.append(range.cloneContents());
  return extractRichTextEditorRuns(wrapper)
    .map((run) => run.text)
    .join("").length;
}

function findTextPosition(
  root: HTMLElement,
  requestedOffset: number,
): { node: Node; offset: number } {
  const target = Math.max(0, Math.trunc(requestedOffset));
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  let consumed = 0;
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    last = text;
    const next = consumed + text.data.length;
    if (target <= next) return { node: text, offset: target - consumed };
    consumed = next;
  }
  if (last) return { node: last, offset: last.data.length };
  return { node: root, offset: 0 };
}

function readRunStyle(element: HTMLElement): Omit<TextStyleRun, "text"> {
  const sizePx = parseOptionalNumber(element.dataset.sizePx);
  const opacity = parseOptionalNumber(element.dataset.opacity);
  return {
    bold: element.dataset.bold === "true",
    italic: element.dataset.italic === "true",
    ...(sizePx === undefined ? {} : { sizePx }),
    ...(element.dataset.fontFamily
      ? { fontFamily: element.dataset.fontFamily }
      : {}),
    ...(opacity === undefined ? {} : { opacity }),
  };
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function createRunSpan(
  root: HTMLElement,
  run: TextStyleRun,
  options: RichTextEditorRenderOptions,
  baseSize: number,
  text: string,
): HTMLSpanElement {
  const span = root.ownerDocument.createElement("span");
  span.setAttribute(RUN_ATTRIBUTE, "");
  span.dataset.bold = run.bold ? "true" : "false";
  span.dataset.italic = run.italic ? "true" : "false";
  if (run.sizePx !== undefined) span.dataset.sizePx = String(run.sizePx);
  if (run.fontFamily) span.dataset.fontFamily = run.fontFamily;
  if (run.opacity !== undefined) span.dataset.opacity = String(run.opacity);

  const absoluteSize = run.sizePx ?? baseSize;
  span.style.fontSize = `${clampPreviewFontSize((absoluteSize / baseSize) * 16)}px`;
  span.style.fontFamily = options.resolveFontFamily(run.fontFamily);
  span.style.fontWeight = options.baseBold || run.bold ? "800" : "400";
  span.style.fontStyle = options.baseItalic || run.italic ? "italic" : "normal";
  span.style.opacity = String(run.opacity ?? options.baseOpacity);
  span.append(root.ownerDocument.createTextNode(text));
  return span;
}

function runBoundaries(
  runLength: number,
  plainOffset: number,
  selection: RichTextEditorSelection | null | undefined,
): number[] {
  const boundaries = new Set([0, runLength]);
  if (selection && selection.end > selection.start) {
    for (const absoluteOffset of [selection.start, selection.end]) {
      const localOffset = absoluteOffset - plainOffset;
      if (localOffset > 0 && localOffset < runLength) {
        boundaries.add(localOffset);
      }
    }
  }
  return [...boundaries].sort((left, right) => left - right);
}

function clampPreviewFontSize(value: number): number {
  return Math.max(9, Math.min(56, value));
}

function textLength(runs: readonly TextStyleRun[]): number {
  return runs.reduce((total, run) => total + run.text.length, 0);
}

function endsWithNewline(runs: readonly TextStyleRun[]): boolean {
  return runs.at(-1)?.text.endsWith("\n") ?? false;
}
