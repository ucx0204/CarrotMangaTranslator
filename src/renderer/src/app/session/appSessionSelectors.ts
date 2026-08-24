import type {
  ChapterSnapshot,
  MangaPage,
} from "../../../../shared/libraryTypes";
import type { JobState } from "../../../../shared/jobTypes";

export type NeighborImageTarget = {
  pageId: string;
  imagePath: string;
  originalImagePath: string;
};

export type WorkspaceImageResolution = {
  imageDataUrl: string;
  peekAvailable: boolean;
  showingOriginalPeek: boolean;
};

export function isWorkspaceImageReadyForSelectedPage({
  selectedPage,
  workspaceImageDataUrl,
  workspaceImagePageId,
}: {
  selectedPage: MangaPage | null;
  workspaceImageDataUrl: string;
  workspaceImagePageId: string | null;
}): boolean {
  return Boolean(
    selectedPage &&
    workspaceImageDataUrl &&
    workspaceImagePageId === selectedPage.id,
  );
}

export function resolveSelectedPage(
  currentChapter: ChapterSnapshot | null,
  selectedPageId: string | null,
): MangaPage | null {
  return (
    currentChapter?.pages.find((page) => page.id === selectedPageId) ??
    currentChapter?.pages[0] ??
    null
  );
}

export function resolveNeighborImageTargets(
  pages: MangaPage[] | undefined,
  selectedPage: MangaPage | null,
): NeighborImageTarget[] {
  if (!pages || !selectedPage) {
    return [];
  }
  const index = pages.findIndex((page) => page.id === selectedPage.id);
  if (index < 0) {
    return [];
  }

  const targets: NeighborImageTarget[] = [];
  for (const offset of [1, -1]) {
    const neighbor = pages[index + offset];
    if (neighbor) {
      targets.push({
        pageId: neighbor.id,
        imagePath: neighbor.inpaintedImagePath ?? neighbor.imagePath,
        originalImagePath: neighbor.imagePath,
      });
    }
  }
  return targets;
}

export function resolveModalOpen(
  modalValues: readonly unknown[],
  commandPaletteOpen: boolean,
  shortcutHelpOpen: boolean,
): boolean {
  return modalValues.some(Boolean) || commandPaletteOpen || shortcutHelpOpen;
}

export function resolveSessionModalState({
  commandPaletteOpen,
  overlayModalValues,
  shortcutHelpOpen,
  translationSourceOpen,
}: {
  commandPaletteOpen: boolean;
  overlayModalValues: readonly unknown[];
  shortcutHelpOpen: boolean;
  translationSourceOpen: boolean;
}): {
  dropImportModalBlocked: boolean;
  modalOpen: boolean;
  overlayModalsOpen: boolean;
} {
  const overlayModalsOpen = resolveModalOpen(
    [translationSourceOpen, ...overlayModalValues],
    false,
    false,
  );
  return {
    dropImportModalBlocked: resolveModalOpen(
      overlayModalValues,
      commandPaletteOpen,
      shortcutHelpOpen,
    ),
    modalOpen: resolveModalOpen(
      [overlayModalsOpen],
      commandPaletteOpen,
      shortcutHelpOpen,
    ),
    overlayModalsOpen,
  };
}

export function resolveJobActive(status: JobState["status"]): boolean {
  return ["starting", "running", "cancelling"].includes(status);
}

export function resolveWorkspaceImageDataUrl({
  peekOriginal,
  selectedPage,
  selectedPageImageDataUrl,
  selectedPageOriginalImageDataUrl,
}: {
  peekOriginal: boolean;
  selectedPage: MangaPage | null;
  selectedPageImageDataUrl: string;
  selectedPageOriginalImageDataUrl: string;
}): WorkspaceImageResolution {
  const peekAvailable = Boolean(
    selectedPage?.inpaintedImagePath && selectedPageOriginalImageDataUrl,
  );
  const showingOriginalPeek = peekOriginal && peekAvailable;
  return {
    imageDataUrl: showingOriginalPeek
      ? selectedPageOriginalImageDataUrl
      : selectedPageImageDataUrl,
    peekAvailable,
    showingOriginalPeek,
  };
}
