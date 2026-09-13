import { useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  BLOCK_CLIPBOARD_MIME,
  instantiateClipboardBlocks,
  parseBlockClipboard,
  serializeBlockClipboard,
} from "../../../shared/blockClipboard";
import { resolvePageBlockOrder } from "../../../shared/blockReadingOrder";
import { MAX_BLOCKS_PER_PAGE } from "../../../shared/ipcSchemaPrimitives";
import { isEditableTarget } from "../lib/appHelpers";
import { resolveVisibleStageCenter } from "./useBlockReadingOrderActions";
import type { UseBlockEditingActionsOptions } from "./blockEditingActionTypes";

type BlockClipboardOptions = UseBlockEditingActionsOptions & {
  blocked: boolean;
};

/** Native clipboard events keep Ctrl/Cmd+C/V and text editing interoperable. */
export function useBlockClipboard(options: BlockClipboardOptions): void {
  const { t } = useTranslation("renderer");
  useLayoutEffect(() => {
    const onCopy = (event: ClipboardEvent): void => {
      if (
        !canHandleClipboard(event, options) ||
        !event.clipboardData ||
        window.getSelection()?.isCollapsed === false
      )
        return;
      try {
        const count = copySelectedBlocks(event.clipboardData, options);
        if (!count) return;
        event.preventDefault();
        options.pushStatus(t("blockEditing.copiedBlocks", { count }));
      } catch (_error) {
        event.preventDefault();
        options.pushStatus(t("blockEditing.copyFailed"));
      }
    };
    const onPaste = (event: ClipboardEvent): void => {
      if (
        !canHandleClipboard(event, options) ||
        options.selectedPageEditLocked ||
        !event.clipboardData
      )
        return;
      const serialized = event.clipboardData.getData(BLOCK_CLIPBOARD_MIME);
      if (!serialized) return;
      event.preventDefault();
      try {
        pasteBlocks(serialized, options, t("workspaceHistory.pasteBlocks"));
      } catch (_error) {
        options.pushStatus(
          t("blockEditing.pasteFailed", { count: MAX_BLOCKS_PER_PAGE }),
        );
      }
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [options, t]);
}

function canHandleClipboard(
  event: ClipboardEvent,
  options: BlockClipboardOptions,
): boolean {
  return Boolean(
    !event.defaultPrevented &&
    !options.blocked &&
    options.currentChapter &&
    options.selectedPage &&
    event.clipboardData &&
    !isEditableTarget(event.target) &&
    !isEditableTarget(document.activeElement),
  );
}

function copySelectedBlocks(
  data: DataTransfer,
  options: BlockClipboardOptions,
): number {
  const page = options.selectedPage;
  if (!page) return 0;
  const selectedIds = new Set(
    options.selectedBlockIds.length
      ? options.selectedBlockIds
      : options.selectedBlock
        ? [options.selectedBlock.id]
        : [],
  );
  const byId = new Map(page.blocks.map((block) => [block.id, block]));
  const blocks = resolvePageBlockOrder(page, options.readingDirection ?? "rtl")
    .filter((id) => selectedIds.has(id))
    .flatMap((id) => byId.get(id) ?? []);
  if (!blocks.length) return 0;
  const serialized = serializeBlockClipboard(blocks, page);
  data.setData(BLOCK_CLIPBOARD_MIME, serialized);
  data.setData(
    "text/plain",
    blocks.map((block) => block.translatedText || block.sourceText).join("\n"),
  );
  return blocks.length;
}

function pasteBlocks(
  serialized: string,
  options: BlockClipboardOptions,
  label: string,
): void {
  const page = options.selectedPage;
  if (!page) return;
  const payload = parseBlockClipboard(serialized);
  const blocks = instantiateClipboardBlocks(
    payload,
    page,
    resolveVisibleStageCenter(options.stageRef?.current ?? null),
    () => `pasted-${globalThis.crypto.randomUUID()}`,
  );
  const ids = blocks.map((block) => block.id);
  const primaryId = ids[0];
  if (!primaryId) return;
  options.updateCurrentChapter(
    page.id,
    (current) => {
      if (
        current.id !== options.currentChapter?.id ||
        current.workId !== options.currentChapter.workId
      )
        return current;
      return {
        ...current,
        pages: current.pages.map((target) => {
          if (target.id !== page.id) return target;
          if (target.blocks.length + blocks.length > MAX_BLOCKS_PER_PAGE) {
            throw new Error("Page block limit exceeded");
          }
          return {
            ...target,
            blocks: [...target.blocks, ...blocks],
            blockOrder: [
              ...resolvePageBlockOrder(
                target,
                options.readingDirection ?? "rtl",
              ),
              ...ids,
            ],
            updatedAt: new Date().toISOString(),
          };
        }),
      };
    },
    {
      label,
      selectionAfter: {
        selectedPageId: page.id,
        selectedBlockId: primaryId,
        selectedBlockIds: ids,
      },
    },
  );
  options.setSelectedBlockId(primaryId);
  options.setSelectedBlockIds(ids);
}
