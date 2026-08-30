import { describe, expect, it, vi } from "vitest";
import { createModalCloseActions } from "../src/renderer/src/app/session/createModalCloseActions";
import { createShareImportInitialState } from "../src/renderer/src/components/shareImport/shareImportInitialState";
import type { LibraryIndex } from "../src/shared/libraryTypes";
import type { WorkShareImportPreview } from "../src/shared/shareTypes";

describe("background modal close actions", () => {
  it("closes launch surfaces and clears only drafts that are not running", () => {
    const cancelImportPreview = vi.fn(async () => undefined);
    const setRenameTarget = vi.fn();
    const setShareExportDraft = vi.fn();
    const setShareExportOpen = vi.fn();
    const setShareImportDraft = vi.fn();
    const setShareImportPreview = vi.fn();
    const setTranslationSourceOpen = vi.fn();
    const setWebImportBackgrounded = vi.fn();
    const setWebImportOpen = vi.fn();
    const closeSettings = vi.fn();
    const closeInpaintingGuide = vi.fn();
    const actions = createModalCloseActions(
      modalCloseInput({
        guidePreference: { closeInpaintingGuide },
        importShareActions: { cancelImportPreview },
        importShareModal: {
          setShareExportDraft,
          setShareExportOpen,
          setShareImportDraft,
          setShareImportPreview,
          setTranslationSourceOpen,
          setWebImportBackgrounded,
          setWebImportOpen,
          shareExportBusy: false,
          shareImportBusy: false,
        },
        libraryActions: { renameBusy: false, setRenameTarget },
        settingsDialog: { closeSettings },
      }),
    );

    actions.onCancelImport();
    actions.onCancelWebImport();
    actions.onCancelRename();
    actions.onCancelSettings();
    actions.onCancelShareExport();
    actions.onCancelShareImport();
    actions.onCancelTranslationSource();
    actions.onCloseInpaintingGuide(false);

    expect(cancelImportPreview).toHaveBeenCalledOnce();
    expect(setWebImportBackgrounded).toHaveBeenCalledWith(false);
    expect(setWebImportOpen).toHaveBeenCalledWith(false);
    expect(setRenameTarget).toHaveBeenCalledWith(null);
    expect(closeSettings).toHaveBeenCalledOnce();
    expect(setShareExportDraft).toHaveBeenCalledWith(null);
    expect(setShareExportOpen).toHaveBeenCalledWith(false);
    expect(setShareImportDraft).toHaveBeenCalledWith(null);
    expect(setShareImportPreview).toHaveBeenCalledWith(null);
    expect(setTranslationSourceOpen).toHaveBeenCalledWith(false);
    expect(closeInpaintingGuide).toHaveBeenCalledWith(false);
  });

  it("does not discard a running share draft or rename target", () => {
    const setRenameTarget = vi.fn();
    const setShareExportDraft = vi.fn();
    const setShareExportOpen = vi.fn();
    const setShareImportDraft = vi.fn();
    const setShareImportPreview = vi.fn();
    const actions = createModalCloseActions(
      modalCloseInput({
        guidePreference: { closeInpaintingGuide: vi.fn() },
        importShareActions: { cancelImportPreview: vi.fn() },
        importShareModal: {
          setShareExportDraft,
          setShareExportOpen,
          setShareImportDraft,
          setShareImportPreview,
          shareExportBusy: true,
          shareImportBusy: true,
        },
        libraryActions: { renameBusy: true, setRenameTarget },
        settingsDialog: { closeSettings: vi.fn() },
      }),
    );

    actions.onCancelRename();
    actions.onCancelShareExport();
    actions.onCancelShareImport();

    expect(setRenameTarget).not.toHaveBeenCalled();
    expect(setShareExportDraft).not.toHaveBeenCalled();
    expect(setShareExportOpen).not.toHaveBeenCalled();
    expect(setShareImportDraft).not.toHaveBeenCalled();
    expect(setShareImportPreview).not.toHaveBeenCalled();
  });
});

function modalCloseInput(
  value: unknown,
): Parameters<typeof createModalCloseActions>[0] {
  return value as Parameters<typeof createModalCloseActions>[0];
}

describe("share import draft restoration", () => {
  it("restores an exact new-work draft including disabled package chapters", () => {
    const state = createShareImportInitialState(LIBRARY, PREVIEW, {
      target: { mode: "new", title: "Edited work" },
      entries: [
        {
          source: "package",
          packageChapterId: "package-2",
          title: "Edited package 2",
        },
      ],
      remainingPackageChapters: [PREVIEW.chapters[0]],
      deletedExistingChapters: [],
    });

    expect(state).toMatchObject({
      targetMode: "new",
      newWorkTitle: "Edited work",
      existingWorkId: "work-1",
      newSelections: [
        { packageChapterId: "package-1", title: "Package 1", enabled: false },
        {
          packageChapterId: "package-2",
          title: "Edited package 2",
          enabled: true,
        },
      ],
    });
  });

  it("restores an existing-work merge order and leaves unused packages available", () => {
    const state = createShareImportInitialState(LIBRARY, PREVIEW, {
      target: { mode: "existing", workId: "work-2" },
      entries: [
        {
          source: "package",
          packageChapterId: "package-2",
          title: "Merged package",
        },
        {
          source: "existing",
          chapterId: "chapter-2",
          title: "Kept existing",
        },
        {
          source: "package",
          packageChapterId: "missing-package",
          title: "Stale package",
        },
      ],
      remainingPackageChapters: [PREVIEW.chapters[0]],
      deletedExistingChapters: [],
    });

    expect(state.targetMode).toBe("existing");
    expect(state.existingWorkId).toBe("work-2");
    expect(state.leftItems).toEqual([
      expect.objectContaining({
        source: "package",
        packageChapterId: "package-2",
        title: "Merged package",
      }),
      expect.objectContaining({
        source: "existing",
        chapterId: "chapter-2",
        title: "Kept existing",
      }),
    ]);
    expect(state.candidateItems).toEqual([
      expect.objectContaining({ packageChapterId: "package-1" }),
    ]);
  });
});

const NOW = "2026-08-30T00:00:00.000Z";
const LIBRARY: LibraryIndex = {
  workOrder: ["work-1", "work-2"],
  works: [
    {
      id: "work-1",
      title: "Work 1",
      chapterOrder: ["chapter-1"],
      chapters: [
        {
          id: "chapter-1",
          workId: "work-1",
          title: "Chapter 1",
          status: "idle",
          pageCount: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "work-2",
      title: "Work 2",
      chapterOrder: ["chapter-2"],
      chapters: [
        {
          id: "chapter-2",
          workId: "work-2",
          title: "Chapter 2",
          status: "idle",
          pageCount: 2,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
};

const PREVIEW: WorkShareImportPreview = {
  previewId: "preview-1",
  workTitle: "Package work",
  chapters: [
    { packageChapterId: "package-1", title: "Package 1", pageCount: 3 },
    { packageChapterId: "package-2", title: "Package 2", pageCount: 4 },
  ],
};
