import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import { importWebBoundary } from "./mcpLibraryImportWeb.fixture";
import type { WebImportSessionManager } from "../src/main/webImportSessionManager";
import {
  McpDiscoverChaptersSchema,
  McpChapterDiscoveryReferenceSchema,
  mcpChapterDiscoveryOutputs,
} from "../src/shared/mcpChapterDiscovery";

export function chapterDiscoveryBoundary(paths: () => string[], count = 30) {
  return {
    ...importWebBoundary(paths),
    discoverChapters: vi.fn<WebImportSessionManager["discoverChapters"]>(
      async (request) => ({
        status: "ready",
        result: {
          pageUrl: request.url,
          pageTitle: "Untrusted chapter index",
          links: Array.from({ length: count }, (_, position) => ({
            url: `https://chapters.example/chapter/${position + 1}`,
            label: `Chapter ${position + 1}`,
            position,
          })),
          examined: count,
          skipped: { invalid: 0, offOrigin: 0, duplicate: 0, filtered: 0 },
          truncated: false,
          exhaustive: false,
        },
      }),
    ),
  };
}
export async function chapterDiscoveryFixture(count = 30) {
  let paths: string[] = [];
  const web = chapterDiscoveryBoundary(() => paths, count);
  const f = await libraryImportFixture({ web });
  paths = f.originals;
  const input = McpDiscoverChaptersSchema.parse({
    requestId: randomUUID(),
    url: "https://chapters.example/book",
    allowNetwork: true,
  });
  const discover = async (request = input, caller = f.auth()) => {
    const done = await f.settle(
      await f.invoke("carrot_discover_chapters", request, caller),
      caller.principalId,
    );
    if (done.status !== "completed")
      throw new Error(JSON.stringify({ done, errors: f.errors.map(String) }));
    return McpChapterDiscoveryReferenceSchema.parse(
      done.result?.chapterDiscovery,
    );
  };
  const get = async (id: string, extra: object = {}, caller = f.auth()) =>
    mcpChapterDiscoveryOutputs.carrot_get_chapter_discovery.parse(
      await f.invoke("carrot_get_chapter_discovery", { id, ...extra }, caller),
    );
  return { ...f, web, input, discover, get };
}
