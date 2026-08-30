import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StagedWebImportCandidate } from "../src/main/webImportDownload";
import {
  createSessionDnsLookup,
  WebImportSessionManager,
} from "../src/main/webImportSessionManager";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("createSessionDnsLookup", () => {
  it("uses and caches the isolated Chromium session resolver", async () => {
    const resolveHost = vi.fn(async () => ({
      endpoints: [
        { address: "203.0.113.10", family: "ipv4" as const },
        { address: "2001:db8::10", family: "ipv6" as const },
      ],
    }));
    const lookup = createSessionDnsLookup({ resolveHost });

    const [first, second] = await Promise.all([
      lookup("CDN.EXAMPLE"),
      lookup("cdn.example"),
    ]);

    expect(first).toEqual([
      { address: "203.0.113.10", family: 4 },
      { address: "2001:db8::10", family: 6 },
    ]);
    expect(second).toBe(first);
    expect(resolveHost).toHaveBeenCalledTimes(1);
    expect(resolveHost).toHaveBeenCalledWith("cdn.example", {
      cacheUsage: "allowed",
    });
  });
});

describe("WebImportSessionManager.prepareImport", () => {
  it("reports background progress and transfers the exact selection to preview ownership", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "mgt-web-import-"));
    tempDirs.push(dataRoot);
    const manager = new WebImportSessionManager({ dataRoot });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const directory = join(dataRoot, "tmp", "web-import", sessionId);
    const candidates = [
      candidate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ".jpg"),
      candidate("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ".png"),
      candidate("cccccccc-cccc-4ccc-8ccc-cccccccccccc", ".jpg"),
    ];
    sessionMap(manager).set(sessionId, {
      id: sessionId,
      directory,
      pageTitle: "Background chapter",
      sourceHost: "example.com",
      candidates,
      createdAt: Date.now(),
    });
    const progress: Array<[number, number]> = [];

    const prepared = await manager.prepareImport(
      sessionId,
      [candidates[0].id, candidates[2].id],
      new AbortController().signal,
      (completed, total) => progress.push([completed, total]),
    );

    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(
      prepared.preview.chapters[0]?.pages.map((page) => page.sourcePath),
    ).toEqual([candidates[0].filePath, candidates[2].filePath]);
    expect(manager.resolvePreviewFile(sessionId, candidates[0].id)).toBeNull();
    await prepared.cleanup();
  });
});

type InjectedWebImportSession = {
  id: string;
  directory: string;
  pageTitle: string;
  sourceHost: string;
  candidates: StagedWebImportCandidate[];
  createdAt: number;
};

function sessionMap(
  manager: WebImportSessionManager,
): Map<string, InjectedWebImportSession> {
  return Reflect.get(manager, "sessions") as Map<
    string,
    InjectedWebImportSession
  >;
}

function candidate(
  id: string,
  storedExtension: StagedWebImportCandidate["storedExtension"],
): StagedWebImportCandidate {
  return {
    id,
    filePath: `C:\\staging\\${id}${storedExtension}`,
    sourceFormat: storedExtension === ".jpg" ? "jpeg" : "png",
    storedExtension,
    width: 100,
    height: 200,
    pixelCount: 20_000,
    byteSize: 1_024,
    pageIndex: 0,
  };
}
