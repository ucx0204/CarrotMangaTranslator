import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { BrowserWindow, Session } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StagedWebImportCandidate } from "../src/main/webImportDownload";
import {
  createSessionDnsLookup,
  WebImportSessionManager,
} from "../src/main/webImportSessionManager";
import { WEB_IMPORT_COLLECT_SCRIPT } from "../src/main/webImportPageDiscovery";
import { WEB_IMPORT_SCAN_TIMEOUT_MS } from "../src/shared/webImportTypes";

const scanIo = vi.hoisted(() => ({
  root: "",
  opened: 0,
  closed: 0,
  recursiveRemovals: [] as number[],
  beforeClose: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!scanIo.root) return handle;
      scanIo.opened += 1;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await scanIo.beforeClose?.();
        await close();
        scanIo.closed += 1;
      };
      return handle;
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (
        scanIo.root &&
        args[1]?.recursive &&
        resolve(String(args[0])).startsWith(scanIo.root)
      )
        scanIo.recursiveRemovals.push(scanIo.opened - scanIo.closed);
      return actual.rm(...args);
    },
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  scanIo.root = "";
  scanIo.beforeClose = undefined;
  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("WebImportSessionManager active download cleanup", () => {
  it.each(["cancel", "signal", "deadline", "dispose"] as const)(
    "waits for every staged handle before removing scan directories on %s",
    async (stop) => {
      const dataRoot = await mkdtemp(join(tmpdir(), "mgt-web-import-stop-"));
      expect(resolve(dataRoot).startsWith(resolve(tmpdir()) + sep)).toBe(true);
      tempDirs.push(dataRoot);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      scanIo.root = resolve(dataRoot);
      scanIo.opened = 0;
      scanIo.closed = 0;
      scanIo.recursiveRemovals = [];
      const closeGates = [deferred(), deferred()];
      const closeStarted = [deferred(), deferred()];
      let closing = 0;
      scanIo.beforeClose = () => {
        const index = closing++;
        closeStarted[index].resolve();
        return closeGates[index].promise;
      };
      const bodyStalls = [deferred(), deferred()];
      const bodyCancellation = deferred();
      const fetchSignals: AbortSignal[] = [];
      let cancelledBodies = 0;
      const pageUrl = "https://93.184.216.34/chapter";
      const webRequest: Pick<Session["webRequest"], "onBeforeRequest"> = {
        onBeforeRequest: vi.fn(),
      };
      const session: Partial<Session> = {
        resolveHost: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        on: vi.fn(),
        webRequest: webRequest as Session["webRequest"],
        fetch: vi.fn(async (_url: string, init?: RequestInit) => {
          if (!init?.signal) throw new Error("Expected linked fetch signal");
          const index = fetchSignals.length;
          fetchSignals.push(init.signal);
          let chunkSent = false;
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(stream) {
                  if (!chunkSent) {
                    chunkSent = true;
                    stream.enqueue(new Uint8Array([1, 2, 3]));
                    return;
                  }
                  bodyStalls[index].resolve();
                  return new Promise<void>(() => undefined);
                },
                cancel() {
                  cancelledBodies += 1;
                  return bodyCancellation.promise;
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-type": "image/png" } },
          );
        }),
      };
      let destroyed = false;
      const mainFrame: Pick<
        BrowserWindow["webContents"]["mainFrame"],
        "frames" | "isDestroyed" | "executeJavaScript"
      > = {
        frames: [],
        isDestroyed: () => destroyed,
        executeJavaScript: async (script: string) =>
          script === WEB_IMPORT_COLLECT_SCRIPT
            ? {
                title: "Fixture",
                truncated: false,
                candidates: [0, 1].map((index) => ({
                  url: `${pageUrl}/${index}.png`,
                  x: 0,
                  y: index,
                  discoveryIndex: index,
                })),
              }
            : true,
      };
      const webContents: Pick<
        BrowserWindow["webContents"],
        "getURL" | "mainFrame"
      > = {
        getURL: () => pageUrl,
        mainFrame: mainFrame as BrowserWindow["webContents"]["mainFrame"],
      };
      const window: Partial<BrowserWindow> = {
        loadURL: vi.fn(async () => undefined),
        isDestroyed: () => destroyed,
        destroy: vi.fn(() => {
          destroyed = true;
        }),
        webContents: webContents as BrowserWindow["webContents"],
      };
      const manager = new WebImportSessionManager({
        dataRoot,
        createSession: () => session as Session,
        createWindow: () => window as BrowserWindow,
      });
      const controller = new AbortController();
      const requestId = "11111111-1111-4111-8111-111111111111";
      let scanSettled = false;
      let disposeSettled = false;
      const scan = manager
        .scan({ requestId, url: pageUrl }, controller.signal, vi.fn())
        .finally(() => {
          scanSettled = true;
        });
      let disposal: Promise<void> | undefined;
      try {
        await Promise.all(bodyStalls.map(({ promise }) => promise));
        expect(scanIo.opened).toBe(2);
        if (stop === "cancel")
          expect(await manager.cancelScan(requestId)).toBe(true);
        else if (stop === "signal") controller.abort();
        else if (stop === "deadline")
          await vi.advanceTimersByTimeAsync(WEB_IMPORT_SCAN_TIMEOUT_MS);
        else
          disposal = manager.dispose().finally(() => {
            disposeSettled = true;
          });
        await Promise.all(closeStarted.map(({ promise }) => promise));
        expect(fetchSignals.every((signal) => signal.aborted)).toBe(true);
        expect(cancelledBodies).toBe(2);
        expect(scanSettled).toBe(false);
        expect(disposeSettled).toBe(false);
        expect(scanIo.recursiveRemovals).toEqual([]);
        closeGates[0].resolve();
        await vi.waitFor(() => expect(scanIo.closed).toBe(1));
        expect(scanSettled).toBe(false);
        expect(scanIo.recursiveRemovals).toEqual([]);
        closeGates[1].resolve();
        await expect(scan).resolves.toEqual({
          status: "rejected",
          reason: stop === "deadline" ? "timed-out" : "cancelled",
        });
        await disposal;
        expect(scanIo.closed).toBe(2);
        expect(scanIo.recursiveRemovals.length).toBeGreaterThan(0);
        expect(
          scanIo.recursiveRemovals.every((openHandles) => openHandles === 0),
        ).toBe(true);
        expect(window.destroy).toHaveBeenCalledOnce();
        const stagingRoot = join(dataRoot, "tmp", "web-import");
        if (stop === "dispose") expect(existsSync(stagingRoot)).toBe(false);
        else expect(await readdir(stagingRoot)).toEqual([]);
        expect(session.resolveHost).not.toHaveBeenCalled();
      } finally {
        closeGates.forEach((gate) => gate.resolve());
        bodyCancellation.resolve();
        controller.abort();
        await scan;
        await disposal;
        await manager.dispose();
      }
    },
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
