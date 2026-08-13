import { describe, expect, it } from "vitest";
import type { StagedWebImportCandidate } from "../src/main/webImportDownload";
import { createPreparedWebImportPreview } from "../src/main/webImportSessionManager";

describe("prepared web import preview", () => {
  it("renumbers selected files without gaps and exposes WebP as PNG", () => {
    const preview = createPreparedWebImportPreview({
      pageTitle: "Fixture chapter",
      sourceHost: "page.example",
      candidates: [
        candidate("selected-a", ".jpg", "jpeg"),
        candidate("selected-c", ".png", "webp"),
      ],
    });

    expect(preview.suggestedWorkTitle).toBe("Fixture chapter");
    expect(preview.chapters[0]?.pages).toEqual([
      expect.objectContaining({
        name: "1.jpg",
        sourcePath: "C:\\staging\\selected-a",
        storageStem: "1",
      }),
      expect.objectContaining({
        name: "2.png",
        sourcePath: "C:\\staging\\selected-c",
        storageStem: "2",
      }),
    ]);
  });

  it("falls back to the source host when the document has no title", () => {
    const preview = createPreparedWebImportPreview({
      pageTitle: "",
      sourceHost: "page.example",
      candidates: [candidate("only", ".png", "png")],
    });
    expect(preview.suggestedWorkTitle).toBe("page.example");
    expect(preview.chapters[0]?.title).toBe("page.example");
  });
});

function candidate(
  id: string,
  storedExtension: StagedWebImportCandidate["storedExtension"],
  sourceFormat: StagedWebImportCandidate["sourceFormat"],
): StagedWebImportCandidate {
  return {
    id,
    filePath: `C:\\staging\\${id}`,
    sourceFormat,
    storedExtension,
    width: 100,
    height: 100,
    pixelCount: 10_000,
    byteSize: 100,
    pageIndex: 0,
  };
}
