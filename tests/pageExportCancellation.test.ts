import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { PageExportRenderSession } from "../src/main/pageExport";

const size = { width: 16, height: 16 };
const seen = new Set<string>();
const sessions: PageExportRenderSession[] = [];
const windows: ExportWindow[] = [];
let stalled = "";
let rootDir: string;
let probeSignal: AbortSignal | undefined;

// Only the Electron and image I/O boundaries are faked. The renderer session,
// HTML builder, timeout/cancellation protocol and library leases are real.
function reply<T>(stage: string, value: T): Promise<T> {
  seen.add(stage);
  return stalled === stage ? new Promise<T>(() => {}) : Promise.resolve(value);
}

class ExportWindow {
  loadedPath = "";
  backgroundCalls = 0;
  destroy = vi.fn();
  setContentSize = vi.fn();
  webContents = {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    executeJavaScript: vi.fn(() => reply("render-readiness", size)),
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn((method: string) => {
        if (method === "Emulation.setDefaultBackgroundColorOverride") {
          this.backgroundCalls += 1;
          return reply(`background-${this.backgroundCalls}`, {});
        }
        return reply(method, {
          data: PNG.sync.write(new PNG(size)).toString("base64"),
        });
      }),
    },
  };
  constructor() {
    windows.push(this);
  }
  loadFile(path: string): Promise<void> {
    this.loadedPath = path;
    return reply("page-load", undefined);
  }
}

beforeEach(async () => {
  vi.resetModules();
  vi.doMock("electron", () => ({ BrowserWindow: ExportWindow }));
  rootDir = await mkdtemp(join(tmpdir(), "mgt-cancel-test-"));
  const assets = join(rootDir, "assets");
  await mkdir(assets);
  await Promise.all([
    writeFile(join(assets, "runtime.js"), "// isolated renderer fixture"),
    writeFile(join(assets, "styles.css"), "body { margin: 0; }"),
  ]);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.cancel?.();
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.doUnmock("electron");
  seen.clear();
  windows.length = 0;
  stalled = "";
  probeSignal = undefined;
  await rm(rootDir, { recursive: true, force: true });
});

async function makeSession() {
  const { createPageExportRenderSession } =
    await import("../src/main/pageExport");
  const { createPageExportHtmlSource } =
    await import("../src/main/pageExportHtml");
  const session = await createPageExportRenderSession({
    dataRoot: rootDir,
    probeImageSize: (_path, signal) => {
      probeSignal = signal;
      return reply("image-probe", size);
    },
    resolveImageUrl: () => {
      if (stalled === "image-decode") throw new Error("use image decoder");
      return "data:image/png;base64,";
    },
    decodeFallback: (_path, signal) => {
      probeSignal = signal;
      return reply("image-decode", null);
    },
    htmlSource: createPageExportHtmlSource({
      assetDirectories: () => [join(rootDir, "assets")],
      rendererStylesheet: () =>
        pathToFileURL(join(rootDir, "assets", "styles.css")).href,
      fonts: {
        list: () => [],
        readPreferences: () => ({
          hiddenIds: [],
          favoriteIds: [],
          orderedIds: [],
          defaultFontId: "default",
        }),
        resolveFilePath: () => null,
      },
    }),
  });
  sessions.push(session);
  return session;
}

function makePage(): MangaPage {
  return {
    id: "page",
    name: "page.png",
    imagePath: join(rootDir, "page.png"),
    dataUrl: "",
    ...size,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

it.each([
  "image-probe",
  "image-decode",
  "page-load",
  "render-readiness",
  "Page.enable",
  "Page.captureScreenshot",
  "background-1",
  "background-2",
])("cancels stalled %s without waiting for its timeout", async (stage) => {
  stalled = stage;
  const session = await makeSession();
  const win = windows[0];
  let result: unknown;
  const render = stage.startsWith("background")
    ? session.renderTransparentPage
    : session.renderPage;
  if (!render) throw new Error("Expected transparent page rendering support");
  const rendering = render(makePage(), {
    format: "png",
    resolutionMode: "original",
  }).then(
    () => {
      result = "completed";
    },
    (error: unknown) => {
      result = error;
    },
  );
  await vi.waitFor(() => expect(seen.has(stage)).toBe(true));
  session.cancel?.();
  session.cancel?.();
  await vi.waitFor(() => expect(result).toMatchObject({ name: "AbortError" }), {
    timeout: 500,
  });
  await rendering;
  expect(vi.getTimerCount()).toBe(0);
  expect(win.destroy).toHaveBeenCalledOnce();
  expect(probeSignal?.aborted).toBe(true);
  if (win.loadedPath) expect(existsSync(dirname(win.loadedPath))).toBe(false);
  await expect(session.renderPage(makePage())).rejects.toThrow("closed");
  session.close();
});

it("releases the cancelled sync page lease but preserves another page's owner", async () => {
  stalled = "render-readiness";
  const session = await makeSession();
  const { AppActivityGate } = await import("../src/main/appActivityGate");
  const { libraryMutationCoordinator } =
    await import("../src/main/libraryStore/libraryMutationCoordinator");
  const { withLibraryContentEdit } = await import("../src/main/library/lock");
  const { pageContentResource } =
    await import("../src/shared/appActivityTypes");
  const gate = new AppActivityGate();
  const target = pageContentResource("chapter", "page");
  const other = pageContentResource("chapter", "other");
  libraryMutationCoordinator.configureActivityGate(gate);
  const otherOwner = gate.acquire({
    id: "other",
    kind: "page-edit",
    category: "operation",
    resources: [other],
    blocksQuit: true,
    mutatesLibrary: true,
  });
  let result: unknown;
  const rendering = withLibraryContentEdit([target], () =>
    session.renderPage(makePage(), {
      format: "png",
      resolutionMode: "original",
    }),
  ).then(
    () => {
      result = "completed";
    },
    (error: unknown) => {
      result = error;
    },
  );
  try {
    await vi.waitFor(() => expect(seen.has(stalled)).toBe(true));
    expect(() => gate.assertAvailable([target])).toThrow();
    session.cancel?.();
    await vi.waitFor(
      () => expect(result).toMatchObject({ name: "AbortError" }),
      { timeout: 500 },
    );
    await rendering;
    expect(() => gate.assertAvailable([target])).not.toThrow();
    expect(() => gate.assertAvailable([other])).toThrow();
    expect(libraryMutationCoordinator.getActiveCountForTests()).toBe(0);
    await expect(
      withLibraryContentEdit([target], async () => "edited"),
    ).resolves.toBe("edited");
  } finally {
    session.cancel?.();
    otherOwner.release();
    libraryMutationCoordinator.configureActivityGate(null);
  }
});

it("cancels one session without cancelling an independent session", async () => {
  const first = await makeSession();
  const second = await makeSession();
  stalled = "page-load";
  let result: unknown;
  const rendering = first.renderPage(makePage()).catch((error: unknown) => {
    result = error;
  });
  await vi.waitFor(() => expect(seen.has(stalled)).toBe(true));
  first.cancel?.();
  await vi.waitFor(() => expect(result).toMatchObject({ name: "AbortError" }));
  await rendering;
  stalled = "";
  await expect(second.renderPage(makePage())).resolves.toBeInstanceOf(Buffer);
  expect(windows[1].destroy).not.toHaveBeenCalled();
  second.close();
  expect(windows[1].destroy).toHaveBeenCalledOnce();
});
