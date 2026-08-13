import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportPreviewResult } from "../src/shared/importTypes";
import {
  createImportPreviewSession,
  discardImportPreviewSession,
  disposeImportPreviewSessions,
} from "../src/main/ipc/importPreviewSessionStore";

afterEach(async () => {
  vi.restoreAllMocks();
  await disposeImportPreviewSessions();
});

describe("import preview session cleanup", () => {
  it("runs staged-file cleanup when a preview is explicitly discarded", async () => {
    const cleanup = vi.fn(async () => undefined);
    const session = await createImportPreviewSession(PREVIEW, undefined, {
      cleanup,
      redactSourcePaths: true,
    });
    expect(session.chapters[0]?.pages[0]?.sourcePath).toBe(
      "web-import-staged://1",
    );

    await expect(discardImportPreviewSession(session.previewId)).resolves.toBe(
      true,
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(discardImportPreviewSession(session.previewId)).resolves.toBe(
      false,
    );
  });

  it("cleans an expired preview before creating the next one", async () => {
    const cleanup = vi.fn(async () => undefined);
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    await createImportPreviewSession(PREVIEW, undefined, { cleanup });
    vi.mocked(Date.now).mockReturnValue(1_000 + 30 * 60 * 1_000 + 1);

    await createImportPreviewSession(PREVIEW);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

const PREVIEW: ImportPreviewResult = {
  mode: "single",
  sourceKind: "images",
  suggestedWorkTitle: "Fixture",
  chapters: [
    {
      draftId: "fixture-chapter",
      title: "Fixture",
      sourceKind: "images",
      pages: [
        {
          name: "1.jpg",
          sourcePath: "C:\\fixture\\1.jpg",
          sourceKind: "file",
          storageStem: "1",
        },
      ],
    },
  ],
};
