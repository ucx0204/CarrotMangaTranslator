import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
import { appI18n } from "../../appI18n";
import type { UpdateCurrentChapter } from "../../hooks/useCurrentChapterUpdater";
import {
  applyGatherDirectFormat,
  type GatherDirectFormatRequest,
} from "../../lib/gatherTextFormat";

export function applyGatherTextFormatRequest(
  chapter: ChapterSnapshot | null,
  request: GatherDirectFormatRequest,
  updateCurrentChapter: UpdateCurrentChapter,
): boolean {
  const anchorPageId = request.targets[0]?.pageId;
  if (!chapter || !anchorPageId) return false;

  let applied = false;
  const dirtyPageIds: string[] = [];
  updateCurrentChapter(
    anchorPageId,
    (current) => {
      const result = applyGatherDirectFormat(current, request);
      dirtyPageIds.push(...result.dirtyPageIds);
      applied = result.dirtyPageIds.length > 0;
      return result.chapter;
    },
    {
      dirtyPageIds,
      label: appI18n.t("workspaceHistory.format", { ns: "renderer" }),
    },
  );
  return applied;
}
