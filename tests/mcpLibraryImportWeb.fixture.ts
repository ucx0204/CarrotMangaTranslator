import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { WebImportSessionManager } from "../src/main/webImportSessionManager";

/** Only the browser/download boundary is synthetic; staging and native import stay real. */
export function importWebBoundary(paths: () => string[]) {
  const releasePrepared = vi.fn(async () => {});
  return {
    scan: vi.fn<WebImportSessionManager["scan"]>(async () => ({
      status: "ready",
      result: {
        sessionId: randomUUID(),
        pageTitle: "Synthetic website",
        sourceHost: "example.com",
        candidates: paths().map((_path, index) => ({
          id: randomUUID(),
          previewUrl: "private-preview-not-returned",
          width: 100,
          height: 100,
          pixelCount: 10000,
          byteSize: 200,
          format: "png",
          storedExtension: ".png",
          pageIndex: index,
        })),
        skipped: { unsupported: 1, failed: 2, duplicate: 1, blocked: 1 },
        truncated: true,
      },
    })),
    prepareImport: vi.fn<WebImportSessionManager["prepareImport"]>(
      async () => ({
        preview: {
          mode: "single",
          sourceKind: "images",
          suggestedWorkTitle: "Web work",
          chapters: [
            {
              draftId: randomUUID(),
              title: "Web chapter",
              sourceKind: "images",
              pages: paths().map((sourcePath, index) => ({
                name: `web-${index + 1}.png`,
                sourcePath,
                sourceKind: "file",
                storageStem: String(index + 1),
              })),
            },
          ],
        },
        cleanup: releasePrepared,
      }),
    ),
    discardSession: vi.fn<WebImportSessionManager["discardSession"]>(
      async () => true,
    ),
    dispose: vi.fn<WebImportSessionManager["dispose"]>(async () => {}),
    releasePrepared,
  };
}
