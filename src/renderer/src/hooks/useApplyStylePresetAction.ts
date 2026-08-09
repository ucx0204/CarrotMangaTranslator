import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { BlockStylePreset } from "../../../shared/blockStylePresets";
import { resolveBlockStylePresetPatch } from "../../../shared/blockStylePresets";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";
import { applyFormatToChapterPages } from "../lib/blockFormatApply";
import { toast } from "../lib/toastStore";

const EMPTY_FONT_IDS: ReadonlySet<string> = new Set();
const EMPTY_STYLE_PRESETS: readonly BlockStylePreset[] = [];

type ApplyStylePresetOptions = {
  availableFontIds?: ReadonlySet<string>;
  blockStylePresets?: readonly BlockStylePreset[];
  pushStatus: (line: string) => void;
  selectedBlockIds: string[];
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  updateCurrentChapter: UpdateCurrentChapter;
};

export function useApplyStylePresetAction({
  availableFontIds = EMPTY_FONT_IDS,
  blockStylePresets = EMPTY_STYLE_PRESETS,
  pushStatus,
  selectedBlockIds,
  selectedPage,
  selectedPageEditLocked,
  updateCurrentChapter,
}: ApplyStylePresetOptions): (presetId: string) => void {
  const { t } = useTranslation("renderer");
  return useCallback(
    (presetId) => {
      const preset = blockStylePresets.find((item) => item.id === presetId);
      if (
        !preset ||
        !selectedPage ||
        selectedPageEditLocked ||
        selectedBlockIds.length === 0
      ) {
        return;
      }
      const missingFont = Boolean(
        preset.groupIds.includes("font") &&
        preset.format.fontFamily &&
        !availableFontIds.has(preset.format.fontFamily),
      );
      const patch = resolveBlockStylePresetPatch(preset, {
        omitFont: missingFont,
      });
      if (Object.keys(patch).length > 0) {
        applyPresetPatch({
          patch,
          selectedBlockIds,
          selectedPage,
          updateCurrentChapter,
          historyLabel: t("workspaceHistory.stylePreset"),
        });
        pushStatus(
          t("stylePresets.applied", {
            count: new Set(selectedBlockIds).size,
            name: preset.name,
          }),
        );
      }
      if (missingFont) {
        const message = t("stylePresets.missingFont", {
          font: preset.format.fontFamily,
        });
        pushStatus(message);
        toast.warn(message);
      }
    },
    [
      availableFontIds,
      blockStylePresets,
      pushStatus,
      selectedBlockIds,
      selectedPage,
      selectedPageEditLocked,
      t,
      updateCurrentChapter,
    ],
  );
}

function applyPresetPatch({
  historyLabel,
  patch,
  selectedBlockIds,
  selectedPage,
  updateCurrentChapter,
}: {
  historyLabel: string;
  patch: Parameters<typeof applyFormatToChapterPages>[3];
  selectedBlockIds: string[];
  selectedPage: MangaPage;
  updateCurrentChapter: UpdateCurrentChapter;
}): void {
  const selectedIds = new Set(selectedBlockIds);
  updateCurrentChapter(
    selectedPage.id,
    (current) =>
      applyFormatToChapterPages(
        current,
        new Set([selectedPage.id]),
        selectedIds,
        patch,
      ),
    { label: historyLabel },
  );
}
