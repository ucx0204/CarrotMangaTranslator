import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow, Session } from "electron";
import { expect, it, vi } from "vitest";
import { WebImportSessionManager } from "../src/main/webImportSessionManager";
import { WEB_CHAPTER_LINKS_SCRIPT } from "../src/main/webChapterDiscovery";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chapter-browser-fixture-"));
  const url = "https://93.184.216.34/book";
  let currentUrl = url;
  let destroyed = false;
  const data = {
    title: "Index",
    truncated: false,
    links: [
      {
        href: "https://93.184.216.34/chapter/1",
        label: "Chapter 1",
        position: 0,
      },
    ],
  };
  const executeJavaScript = vi.fn(
    async (script: string): Promise<unknown> =>
      script === WEB_CHAPTER_LINKS_SCRIPT ? data : true,
  );
  const webRequest: Pick<Session["webRequest"], "onBeforeRequest"> = {
    onBeforeRequest: vi.fn(),
  };
  const session: Partial<Session> = {
    resolveHost: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
    webRequest: webRequest as Session["webRequest"],
    fetch: vi.fn(),
  };
  const mainFrame: Pick<
    BrowserWindow["webContents"]["mainFrame"],
    "frames" | "isDestroyed" | "executeJavaScript"
  > = {
    frames: [],
    isDestroyed: () => destroyed,
    executeJavaScript,
  };
  const webContents: Pick<
    BrowserWindow["webContents"],
    "getURL" | "mainFrame"
  > = {
    getURL: () => currentUrl,
    mainFrame: mainFrame as BrowserWindow["webContents"]["mainFrame"],
  };
  const window: Partial<BrowserWindow> = {
    loadURL: vi.fn(async () => {}),
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    webContents: webContents as BrowserWindow["webContents"],
  };
  const createWindow = vi.fn(() => window as BrowserWindow);
  const errors: unknown[] = [];
  const manager = new WebImportSessionManager({
    dataRoot: root,
    createWindow,
    createSession: () => session as Session,
    reportError: (_message, error) => errors.push(error),
  });
  const request = { requestId: randomUUID(), url, maxLinks: 100 };
  const progress = vi.fn();
  return {
    root,
    url,
    manager,
    window,
    session,
    createWindow,
    request,
    executeJavaScript,
    progress,
    errors,
    setUrl: (value: string) => {
      currentUrl = value;
    },
    run: (signal = new AbortController().signal) =>
      manager.discoverChapters(request, signal, progress),
    close: async () => {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("shares native page policy but does not run the image downloader or leave a preview session", async () => {
  const f = await fixture();
  try {
    expect(await f.run()).toMatchObject({
      status: "ready",
      result: { links: [{ label: "Chapter 1" }], exhaustive: false },
    });
    expect(f.session.fetch).not.toHaveBeenCalled();
    expect(f.session.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(f.window.destroy).toHaveBeenCalledOnce();
    expect(await readdir(join(f.root, "tmp", "web-import"))).toEqual([]);
    expect(f.progress.mock.calls.map(([event]) => event.stage)).not.toContain(
      "downloading",
    );
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it.each(["http://127.0.0.1/private", "https://user:secret@93.184.216.34/book"])(
  "rejects unsafe requested URL %s before creating a browser",
  async (url) => {
    const f = await fixture();
    try {
      f.request.url = url;
      expect(await f.run()).toMatchObject({ status: "rejected" });
      expect(f.createWindow).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("revalidates the loaded page URL and rejects private redirects", async () => {
  const f = await fixture();
  try {
    f.setUrl("http://127.0.0.1/redirected");
    expect(await f.run()).toEqual({
      status: "rejected",
      reason: "private-address",
    });
    expect(f.executeJavaScript).not.toHaveBeenCalled();
    expect(f.window.destroy).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("rejects navigation during extraction rather than binding candidates to the wrong source", async () => {
  const f = await fixture();
  try {
    f.executeJavaScript.mockImplementation(async (script) => {
      if (script !== WEB_CHAPTER_LINKS_SCRIPT) return true;
      f.setUrl("https://93.184.216.34/another");
      return { title: "changed", links: [], truncated: false };
    });
    expect(await f.run()).toEqual({
      status: "rejected",
      reason: "page-unavailable",
    });
    expect(f.window.destroy).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("does not start an already-cancelled inspection", async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    abort.abort();
    expect(await f.run(abort.signal)).toEqual({
      status: "rejected",
      reason: "cancelled",
    });
    expect(f.createWindow).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(["signal", "cancel", "dispose"] as const)(
  "closes a stalled discovery browser on %s without producing candidates",
  async (stop) => {
    const f = await fixture();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.executeJavaScript.mockImplementation(async (script) => {
      if (script !== WEB_CHAPTER_LINKS_SCRIPT) return true;
      started();
      return new Promise<never>(() => {});
    });
    const abort = new AbortController();
    const run = f.run(abort.signal);
    try {
      await ready;
      if (stop === "signal") abort.abort();
      else if (stop === "cancel")
        await f.manager.cancelScan(f.request.requestId);
      else await f.manager.dispose();
      expect(await run).toEqual({ status: "rejected", reason: "cancelled" });
      expect(f.window.destroy).toHaveBeenCalledOnce();
      expect(f.session.fetch).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      await run;
      await f.close();
    }
  },
);
