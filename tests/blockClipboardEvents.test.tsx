/** @vitest-environment jsdom */
import { useRef, useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLOCK_CLIPBOARD_MIME,
  serializeBlockClipboard,
} from "../src/shared/blockClipboard";
import { MAX_BLOCKS_PER_PAGE } from "../src/shared/ipcSchemaPrimitives";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { useBlockClipboard } from "../src/renderer/src/hooks/useBlockClipboard";
import { useCurrentChapterUpdater } from "../src/renderer/src/hooks/useCurrentChapterUpdater";
import type { RecordWorkspaceChapterEdit } from "../src/renderer/src/hooks/workspaceHistoryEntries";
import { restoreWorkspaceChapterEditSnapshot } from "../src/renderer/src/lib/workspaceHistory";
import { clipboardBlock, clipboardChapter } from "./fixtures/blockClipboard";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

describe("native block copy and paste events", () => {
  it.each([
    {
      workId: "source-work",
      chapterId: "source-chapter",
      pageId: "other-page",
    },
    { workId: "source-work", chapterId: "other-chapter", pageId: "other-page" },
    { workId: "other-work", chapterId: "other-chapter", pageId: "other-page" },
  ])(
    "pastes into $workId / $chapterId / $pageId after navigation",
    (destination) => {
      const source = clipboardChapter([
        clipboardBlock(),
        { ...clipboardBlock("text"), generatedLettering: undefined },
      ]);
      const { result } = renderClipboard(source);
      const clipboard = clipboardData();
      expect(dispatchClipboard("copy", clipboard).defaultPrevented).toBe(true);
      expect(clipboard.getData("text/plain")).toBe("쾅!\n쾅!");
      // The clipboard contains a snapshot independent from subsequent source edits.
      source.pages[0]?.blocks.forEach((block) => {
        block.translatedText = "changed";
      });
      act(() => result.current.navigate(clipboardChapter([], destination)));
      expect(dispatchClipboard("paste", clipboard).defaultPrevented).toBe(true);
      const pastedPage = result.current.chapter?.pages[0];
      if (!pastedPage) throw new Error("missing destination page");
      expect(pastedPage.blocks.map((block) => block.translatedText)).toEqual([
        "쾅!",
        "쾅!",
      ]);
      const pasted = pastedPage.blocks;
      expect(pasted[0]?.generatedLettering?.dataUrl).toBe(
        clipboardBlock().generatedLettering?.dataUrl,
      );
      expect(result.current.selectedIds).toEqual(
        pasted.map((block) => block.id),
      );
      expect(result.current.history).toHaveLength(1);
      const edit = result.current.history[0];
      const current = result.current.chapter;
      if (!edit || !current) throw new Error("missing paste history");
      expect(edit.label).toBe("블록 붙여넣기");
      expect(edit.before).not.toEqual(edit.after);
      const undone = restoreWorkspaceChapterEditSnapshot(current, edit.before);
      expect(undone.pages[0]?.blocks).toHaveLength(0);
      const redone = restoreWorkspaceChapterEditSnapshot(undone, edit.after);
      expect(redone.pages[0]?.blocks).toEqual(pasted);
      dispatchClipboard("paste", clipboard);
      const allIds =
        result.current.chapter?.pages[0]?.blocks.map((block) => block.id) ?? [];
      expect(new Set(allIds).size).toBe(4);
      expect(result.current.chapter?.pages[0]?.blockOrder).toEqual(allIds);
      expect(result.current.history).toHaveLength(2);
    },
  );

  it("survives an unmounted source session without a global in-memory clipboard", () => {
    const source = renderClipboard(clipboardChapter());
    const data = clipboardData();
    dispatchClipboard("copy", data);
    source.unmount();
    const destination = renderClipboard(clipboardChapter([]));
    dispatchClipboard("paste", data);
    expect(destination.result.current.chapter?.pages[0]?.blocks).toHaveLength(
      1,
    );
  });

  it.each(["input", "textarea", "contenteditable"])(
    "preserves native text copy and paste in %s",
    (kind) => {
      const { result } = renderClipboard(clipboardChapter());
      const data = validClipboard();
      const element = document.createElement(
        kind === "contenteditable" ? "div" : kind,
      );
      if (kind === "contenteditable")
        element.setAttribute("contenteditable", "true");
      document.body.append(element);
      element.focus();
      expect(dispatchClipboard("copy", data, element).defaultPrevented).toBe(
        false,
      );
      expect(dispatchClipboard("paste", data, element).defaultPrevented).toBe(
        false,
      );
      expect(result.current.history).toHaveLength(0);
    },
  );

  it("leaves selected DOM text and unrelated clipboard content to native handlers", () => {
    const { result } = renderClipboard(clipboardChapter());
    const text = document.createElement("p");
    text.textContent = "ordinary selected text";
    document.body.append(text);
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()?.addRange(range);
    expect(dispatchClipboard("copy", clipboardData()).defaultPrevented).toBe(
      false,
    );
    expect(dispatchClipboard("paste", clipboardData()).defaultPrevented).toBe(
      false,
    );
    expect(result.current.history).toHaveLength(0);
  });

  it("blocks modal and locked-page edits, and rejects bad payloads atomically", () => {
    const { result, rerender } = renderClipboard(clipboardChapter([]));
    rerender({ blocked: true, locked: false });
    expect(dispatchClipboard("paste", validClipboard()).defaultPrevented).toBe(
      false,
    );
    rerender({ blocked: false, locked: true });
    expect(dispatchClipboard("paste", validClipboard()).defaultPrevented).toBe(
      false,
    );
    rerender({ blocked: false, locked: false });
    const malformed = clipboardData();
    malformed.setData(BLOCK_CLIPBOARD_MIME, "broken");
    expect(dispatchClipboard("paste", malformed).defaultPrevented).toBe(true);
    expect(result.current.history).toHaveLength(0);
    expect(result.current.status).toHaveBeenCalledOnce();
    expect(result.current.chapter?.pages[0]?.blocks).toHaveLength(0);
  });

  it("checks the current page limit before mutating or recording history", () => {
    const page = clipboardChapter(
      Array.from({ length: MAX_BLOCKS_PER_PAGE }, (_, i) => ({
        ...clipboardBlock(`block-${i}`),
        generatedLettering: undefined,
      })),
    );
    const { result } = renderClipboard(page);
    dispatchClipboard("paste", validClipboard());
    expect(result.current.chapter?.pages[0]?.blocks).toHaveLength(
      MAX_BLOCKS_PER_PAGE,
    );
    expect(result.current.history).toHaveLength(0);
    expect(result.current.status).toHaveBeenCalledOnce();
  });
});

function renderClipboard(initialChapter: ChapterSnapshot) {
  return renderHook(
    ({ blocked, locked }) => {
      const [chapter, setChapter] = useState<ChapterSnapshot | null>(
        initialChapter,
      );
      const currentChapterRef = useRef(chapter);
      const [selectedIds, setSelectedIds] = useState(
        initialChapter.pages[0]?.blocks.map((block) => block.id) ?? [],
      );
      const [selectedId, setSelectedId] = useState<string | null>(
        selectedIds[0] ?? null,
      );
      const history = useRef<RecordWorkspaceChapterEdit[]>([]);
      const status = useRef(vi.fn());
      const page = chapter?.pages[0] ?? null;
      const updateCurrentChapter = useCurrentChapterUpdater({
        currentChapterRef,
        setCurrentChapter: setChapter,
        markDirty: () => undefined,
        selection: {
          selectedPageId: page?.id ?? null,
          selectedBlockId: selectedId,
          selectedBlockIds: selectedIds,
        },
        workspaceHistory: {
          recordChapterEdit: (edit) => {
            history.current.push(edit);
            return true;
          },
        },
      });
      useBlockClipboard({
        currentChapter: chapter,
        selectedPage: page,
        selectedBlock:
          page?.blocks.find((block) => block.id === selectedId) ?? null,
        selectedBlockIds: selectedIds,
        setSelectedBlockIds: setSelectedIds,
        setSelectedBlockId: setSelectedId,
        selectedPageEditLocked: locked,
        blocked,
        jobActive: false,
        pushStatus: status.current,
        updateCurrentChapter,
      });
      return {
        chapter,
        selectedIds,
        history: history.current,
        status: status.current,
        navigate: (next: ChapterSnapshot) => {
          currentChapterRef.current = next;
          setChapter(next);
          setSelectedIds([]);
          setSelectedId(null);
        },
      };
    },
    { initialProps: { blocked: false, locked: false } },
  );
}

function clipboardData(): DataTransfer {
  const values = new Map<string, string>();
  return {
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => {
      values.set(type, value);
    },
  } as DataTransfer;
}

function validClipboard(): DataTransfer {
  const data = clipboardData();
  data.setData(
    BLOCK_CLIPBOARD_MIME,
    serializeBlockClipboard([clipboardBlock()], { width: 1200, height: 1800 }),
  );
  return data;
}

function dispatchClipboard(
  type: "copy" | "paste",
  data: DataTransfer,
  target: HTMLElement = document.body,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: data });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}
