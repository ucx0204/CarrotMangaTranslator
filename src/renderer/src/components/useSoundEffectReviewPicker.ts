import React from "react";
import type { BBox } from "../../../shared/textTypes";
import {
  updateAllDraftRegions,
  updateDraftPage,
  updateDraftRegion,
  type SelectedSoundEffectDraftRegion,
  type SoundEffectDraftPage,
} from "./soundEffectTranslationDraftModel";

export function useSoundEffectPickerView(
  draftPages: SoundEffectDraftPage[],
  showAllPages: boolean,
) {
  const visiblePages = React.useMemo(
    () =>
      draftPages.filter(
        (item) =>
          showAllPages || item.regions.some((region) => !region.deleted),
      ),
    [draftPages, showAllPages],
  );
  const [requestedPageId, setRequestedPageId] = React.useState(
    visiblePages[0]?.page.id ?? "",
  );
  const activePage =
    visiblePages.find(({ page }) => page.id === requestedPageId) ??
    visiblePages[0];
  React.useEffect(() => {
    if (activePage && activePage.page.id !== requestedPageId) {
      setRequestedPageId(activePage.page.id);
    }
  }, [activePage, requestedPageId]);
  const candidates = draftPages.flatMap(({ regions }) =>
    regions.filter((region) => !region.deleted),
  );
  return {
    activePage,
    candidateCount: candidates.length,
    selectedCount: candidates.filter((region) => region.included).length,
    setRequestedPageId,
    visiblePages,
  };
}

export function useSoundEffectPickerActions({
  activePageId,
  onDraftChange,
  onRequestedPageChange,
  onSelectedRegionChange,
}: {
  activePageId?: string;
  onDraftChange: React.Dispatch<React.SetStateAction<SoundEffectDraftPage[]>>;
  onRequestedPageChange: (pageId: string) => void;
  onSelectedRegionChange: (selection: SelectedSoundEffectDraftRegion) => void;
}) {
  const updateActiveRegion = React.useCallback(
    (regionId: string, update: Parameters<typeof updateDraftRegion>[3]) => {
      if (!activePageId) return;
      onDraftChange((current) =>
        updateDraftRegion(current, activePageId, regionId, update),
      );
    },
    [activePageId, onDraftChange],
  );
  return {
    selectAll: () =>
      onDraftChange((current) => updateAllDraftRegions(current, true)),
    clearAll: () =>
      onDraftChange((current) => updateAllDraftRegions(current, false)),
    selectPage: (pageId: string) => {
      onRequestedPageChange(pageId);
      onSelectedRegionChange(null);
    },
    createRegion: (bbox: BBox) => {
      if (!activePageId) return;
      const id = `manual-${crypto.randomUUID()}`;
      onDraftChange((current) =>
        updateDraftPage(current, activePageId, (regions) => [
          ...regions,
          {
            id,
            bbox,
            detectorConfidence: 1,
            manual: true,
            newlyAdded: true,
            included: true,
            deleted: false,
          },
        ]),
      );
      onSelectedRegionChange({ pageId: activePageId, regionId: id });
    },
    toggleRegion: (regionId: string) =>
      updateActiveRegion(regionId, (region) => ({
        ...region,
        included: !region.included,
      })),
    updateRegion: (regionId: string, bbox: BBox) =>
      updateActiveRegion(regionId, (region) => ({ ...region, bbox })),
  };
}
