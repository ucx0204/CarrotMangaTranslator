import type { MangaPage } from "../../../shared/libraryTypes";

type OriginalImageOpacityAvailabilityInput = {
  selectedPage: Pick<
    MangaPage,
    "id" | "imagePath" | "inpaintedImagePath"
  > | null;
  selectedPageImageDataUrl: string;
  selectedPageImageDataUrlPageId: string | null;
  selectedPageOriginalImageDataUrl: string;
  selectedPageOriginalImageDataUrlPageId: string | null;
};

export function clampOriginalImageOpacity(opacity: number): number {
  return Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 0;
}

/** Only expose the blend control once both frames belong to the selected page. */
export function isOriginalImageOpacityAvailable({
  selectedPage,
  selectedPageImageDataUrl,
  selectedPageImageDataUrlPageId,
  selectedPageOriginalImageDataUrl,
  selectedPageOriginalImageDataUrlPageId,
}: OriginalImageOpacityAvailabilityInput): boolean {
  if (!selectedPage?.inpaintedImagePath) return false;
  if (selectedPage.inpaintedImagePath === selectedPage.imagePath) return false;
  if (
    selectedPageImageDataUrlPageId !== selectedPage.id ||
    selectedPageOriginalImageDataUrlPageId !== selectedPage.id
  ) {
    return false;
  }
  return Boolean(
    selectedPageImageDataUrl &&
    selectedPageOriginalImageDataUrl &&
    selectedPageImageDataUrl !== selectedPageOriginalImageDataUrl,
  );
}
