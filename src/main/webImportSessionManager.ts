/* eslint-disable max-lines, max-lines-per-function -- scan resource ownership and teardown stay co-located for lifecycle auditability */
import {
  BrowserWindow,
  session as electronSession,
  type Session,
} from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ImportPreviewResult } from "../shared/importTypes";
import { MAX_PAGES_PER_REQUEST } from "../shared/ipcContractCore";
import {
  WEB_IMPORT_SCAN_TIMEOUT_MS,
  type WebImportCandidate,
  type WebImportProgressEvent,
  type WebImportScanRequest,
  type WebImportScanResponse,
  type WebImportScanResult,
} from "../shared/webImportTypes";
import { throwIfAborted } from "./abortSignal";
import {
  downloadDiscoveredWebImages,
  type StagedWebImportCandidate,
} from "./webImportDownload";
import {
  discoverWebImages,
  WEB_IMPORT_SCROLL_SCRIPT,
} from "./webImportPageDiscovery";
import {
  assertPublicWebImportUrl,
  isAllowedWebImportRequest,
  WebImportUrlError,
  type WebImportDnsLookup,
} from "./webImportUrlPolicy";

const WEB_IMPORT_SESSION_TTL_MS = 30 * 60 * 1_000;
const MAX_WEB_IMPORT_SESSIONS = 20;

type WebImportSession = {
  id: string;
  directory: string;
  pageTitle: string;
  sourceHost: string;
  candidates: StagedWebImportCandidate[];
  createdAt: number;
};

type ActiveWebImportScan = {
  requestId: string;
  abortController: AbortController;
  window: BrowserWindow | null;
  directory: string | null;
};

export type PreparedWebImport = {
  preview: ImportPreviewResult;
  cleanup: () => Promise<void>;
};

export type WebImportSessionManagerOptions = {
  dataRoot: string;
  createWindow?: typeof createSecureWebImportWindow;
  createSession?: (partition: string) => Session;
  reportError?: (message: string, detail?: unknown) => void;
};

export type WebImportHostResolver = {
  resolveHost: (
    hostname: string,
    options: { cacheUsage: "allowed" },
  ) => Promise<{
    endpoints: Array<{
      address: string;
      family: "ipv4" | "ipv6" | "unspec";
    }>;
  }>;
};

export class WebImportSessionManager {
  private readonly root: string;
  private readonly createWindow: typeof createSecureWebImportWindow;
  private readonly createSession: (partition: string) => Session;
  private readonly reportError: (message: string, detail?: unknown) => void;
  private readonly sessions = new Map<string, WebImportSession>();
  private readonly activeScans = new Map<string, ActiveWebImportScan>();
  private readonly expiryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private cleanupTail: Promise<void> = Promise.resolve();

  constructor(options: WebImportSessionManagerOptions) {
    this.root = resolve(options.dataRoot, "tmp", "web-import");
    this.createWindow = options.createWindow ?? createSecureWebImportWindow;
    this.createSession =
      options.createSession ??
      ((partition) =>
        electronSession.fromPartition(partition, { cache: false }));
    this.reportError = options.reportError ?? (() => undefined);
  }

  async initialize(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true });
  }

  async scan(
    request: WebImportScanRequest,
    signal: AbortSignal,
    onProgress: (event: WebImportProgressEvent) => void,
  ): Promise<WebImportScanResponse> {
    await this.pruneExpired();
    await this.cancelScan(request.requestId);
    const active: ActiveWebImportScan = {
      requestId: request.requestId,
      abortController: new AbortController(),
      window: null,
      directory: null,
    };
    const deadlineTimer = setTimeout(
      () => active.abortController.abort(new WebImportDeadlineError()),
      WEB_IMPORT_SCAN_TIMEOUT_MS,
    );
    this.activeScans.set(request.requestId, active);
    const onOperationAbort = (): void =>
      active.abortController.abort(signal.reason);
    signal.addEventListener("abort", onOperationAbort, { once: true });
    try {
      return await this.runScan(request, active, onProgress);
    } catch (error) {
      if (
        error instanceof WebImportDeadlineError ||
        active.abortController.signal.reason instanceof WebImportDeadlineError
      ) {
        return { status: "rejected", reason: "timed-out" };
      }
      if (active.abortController.signal.aborted || signal.aborted) {
        return { status: "rejected", reason: "cancelled" };
      }
      if (error instanceof WebImportUrlError) {
        return { status: "rejected", reason: error.reason };
      }
      if (error instanceof WebImportDeadlineError) {
        return { status: "rejected", reason: "timed-out" };
      }
      this.reportError("Web image import scan failed", error);
      return { status: "rejected", reason: "page-unavailable" };
    } finally {
      clearTimeout(deadlineTimer);
      signal.removeEventListener("abort", onOperationAbort);
      this.activeScans.delete(request.requestId);
      destroyWindow(active.window);
      if (active.directory) {
        await rm(active.directory, { recursive: true, force: true });
      }
    }
  }

  async cancelScan(requestId: string): Promise<boolean> {
    const active = this.activeScans.get(requestId);
    if (!active) {
      return false;
    }
    active.abortController.abort(
      new DOMException("Web import scan cancelled", "AbortError"),
    );
    destroyWindow(active.window);
    return true;
  }

  async discardSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    this.sessions.delete(sessionId);
    this.clearSessionExpiry(sessionId);
    await rm(session.directory, { recursive: true, force: true });
    return true;
  }

  async prepareImport(
    sessionId: string,
    selectedCandidateIds: readonly string[],
  ): Promise<PreparedWebImport> {
    await this.pruneExpired();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(
        "웹 이미지 미리보기가 만료되었습니다. 다시 불러와 주세요.",
      );
    }
    const requested = new Set(selectedCandidateIds);
    if (requested.size !== selectedCandidateIds.length) {
      throw new Error("선택한 이미지 목록에 중복 항목이 있습니다.");
    }
    const selected = session.candidates.filter((candidate) =>
      requested.has(candidate.id),
    );
    if (
      selected.length === 0 ||
      selected.length !== requested.size ||
      selected.length > MAX_PAGES_PER_REQUEST
    ) {
      throw new Error("가져올 이미지 선택을 확인해 주세요.");
    }
    const selectedIds = new Set(selected.map((candidate) => candidate.id));
    for (const candidate of session.candidates) {
      if (!selectedIds.has(candidate.id)) {
        await rm(candidate.filePath, { force: true });
      }
    }
    session.candidates = selected;
    this.sessions.delete(sessionId);
    this.clearSessionExpiry(sessionId);
    const preview = createPreparedWebImportPreview({
      candidates: selected,
      pageTitle: session.pageTitle,
      sourceHost: session.sourceHost,
    });
    return {
      preview,
      cleanup: async () => {
        await rm(session.directory, { recursive: true, force: true });
      },
    };
  }

  resolvePreviewFile(sessionId: string, candidateId: string): string | null {
    const session = this.sessions.get(sessionId);
    const candidate = session?.candidates.find(
      (item) => item.id === candidateId,
    );
    if (!session || !candidate) {
      return null;
    }
    const resolved = resolve(candidate.filePath);
    const root = `${resolve(session.directory)}${process.platform === "win32" ? "\\" : "/"}`;
    return resolved.startsWith(root) ? resolved : null;
  }

  async dispose(): Promise<void> {
    for (const active of this.activeScans.values()) {
      active.abortController.abort(
        new DOMException("Web import manager disposed", "AbortError"),
      );
      destroyWindow(active.window);
    }
    this.activeScans.clear();
    this.sessions.clear();
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    await rm(this.root, { recursive: true, force: true });
  }

  private async runScan(
    request: WebImportScanRequest,
    active: ActiveWebImportScan,
    onProgress: (event: WebImportProgressEvent) => void,
  ): Promise<WebImportScanResponse> {
    const signal = active.abortController.signal;
    const deadlineAt = Date.now() + WEB_IMPORT_SCAN_TIMEOUT_MS;
    await mkdir(this.root, { recursive: true });
    emitProgress(onProgress, request.requestId, "validating", 0, 1);
    const requestedUrl = await waitForWebImportStep(
      assertPublicWebImportUrl(request.url),
      deadlineAt,
      signal,
    );
    throwIfAborted(signal);
    emitProgress(onProgress, request.requestId, "validating", 1, 1);

    const sessionId = randomUUID();
    const directory = join(this.root, sessionId);
    await mkdir(directory, { recursive: false });
    active.directory = directory;
    const partition = `web-import-${randomBytes(16).toString("hex")}`;
    const scanSession = this.createSession(partition);
    const dnsLookup = createSessionDnsLookup(scanSession);
    await waitForWebImportStep(
      assertPublicWebImportUrl(requestedUrl.href, dnsLookup),
      deadlineAt,
      signal,
    );
    configureWebImportSession(scanSession, signal, dnsLookup);
    const window = this.createWindow(scanSession);
    active.window = window;
    emitProgress(onProgress, request.requestId, "loading", 0, 1);
    const finalUrl = await loadWebImportPage({
      deadlineAt,
      requestedUrl: requestedUrl.href,
      dnsLookup,
      signal,
      window,
    });
    emitProgress(onProgress, request.requestId, "loading", 1, 1);
    emitProgress(onProgress, request.requestId, "scrolling", 0, 1);
    await waitForWebImportStep(
      window.webContents.mainFrame.executeJavaScript(WEB_IMPORT_SCROLL_SCRIPT),
      deadlineAt,
      signal,
    );
    throwIfDeadlineExceeded(deadlineAt);
    throwIfAborted(signal);
    emitProgress(onProgress, request.requestId, "scrolling", 1, 1);
    emitProgress(onProgress, request.requestId, "discovering", 0, 1);
    const discovery = await waitForWebImportStep(
      discoverWebImages(window.webContents.mainFrame),
      deadlineAt,
      signal,
    );
    emitProgress(onProgress, request.requestId, "discovering", 1, 1);
    throwIfAborted(signal);
    emitProgress(
      onProgress,
      request.requestId,
      "downloading",
      0,
      discovery.candidates.length,
    );
    const downloaded = await waitForWebImportStep(
      downloadDiscoveredWebImages({
        candidates: discovery.candidates,
        deadlineAt,
        directory,
        dnsLookup,
        pageUrl: finalUrl.href,
        session: scanSession,
        signal,
        onProgress: (completed, total) =>
          emitProgress(
            onProgress,
            request.requestId,
            "downloading",
            completed,
            total,
          ),
      }),
      deadlineAt,
      signal,
    );
    throwIfAborted(signal);
    const webSession: WebImportSession = {
      id: sessionId,
      directory,
      pageTitle: sanitizePageTitle(discovery.title),
      sourceHost: finalUrl.hostname,
      candidates: downloaded.candidates,
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, webSession);
    this.scheduleSessionExpiry(webSession);
    active.directory = null;
    await this.pruneExpired();
    const result: WebImportScanResult = {
      sessionId,
      pageTitle: webSession.pageTitle,
      sourceHost: webSession.sourceHost,
      candidates: webSession.candidates.map(toPublicCandidate(sessionId)),
      skipped: downloaded.skipped,
      truncated: discovery.truncated || downloaded.truncated,
    };
    return { status: "ready", result };
  }

  private pruneExpired(): Promise<void> {
    const run = async (): Promise<void> => {
      const expired: WebImportSession[] = [];
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (now - session.createdAt > WEB_IMPORT_SESSION_TTL_MS) {
          this.sessions.delete(id);
          this.clearSessionExpiry(id);
          expired.push(session);
        }
      }
      while (this.sessions.size > MAX_WEB_IMPORT_SESSIONS) {
        const oldestId = this.sessions.keys().next().value;
        if (!oldestId) break;
        const session = this.sessions.get(oldestId);
        this.sessions.delete(oldestId);
        this.clearSessionExpiry(oldestId);
        if (session) expired.push(session);
      }
      await Promise.all(
        expired.map((session) =>
          rm(session.directory, { recursive: true, force: true }),
        ),
      );
    };
    const next = this.cleanupTail.then(run, run);
    this.cleanupTail = next.catch((error) =>
      this.reportError("Web import session cleanup failed", error),
    );
    return next;
  }

  private scheduleSessionExpiry(session: WebImportSession): void {
    this.clearSessionExpiry(session.id);
    const timer = setTimeout(() => {
      this.expiryTimers.delete(session.id);
      void this.discardSession(session.id).catch((error) =>
        this.reportError("Expired web import session cleanup failed", error),
      );
    }, WEB_IMPORT_SESSION_TTL_MS);
    timer.unref();
    this.expiryTimers.set(session.id, timer);
  }

  private clearSessionExpiry(sessionId: string): void {
    const timer = this.expiryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(sessionId);
  }
}

export function createPreparedWebImportPreview({
  candidates,
  pageTitle,
  sourceHost,
}: {
  candidates: readonly StagedWebImportCandidate[];
  pageTitle: string;
  sourceHost: string;
}): ImportPreviewResult {
  const suggestedTitle = pageTitle || sourceHost;
  return {
    mode: "single",
    sourceKind: "images",
    suggestedWorkTitle: suggestedTitle,
    chapters: [
      {
        draftId: randomUUID(),
        title: suggestedTitle,
        sourceKind: "images",
        pages: candidates.map((candidate, index) => ({
          name: `${index + 1}${candidate.storedExtension}`,
          sourcePath: candidate.filePath,
          sourceKind: "file",
          storageStem: String(index + 1),
        })),
      },
    ],
  };
}

export function createSecureWebImportWindow(
  scanSession: Session,
): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: scanSession,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.on("will-navigate", (event, url) => {
    void isAllowedWebImportRequest(url).then((allowed) => {
      if (!allowed && !window.isDestroyed()) {
        window.webContents.stop();
      }
    });
  });
  window.webContents.on("will-prevent-unload", (event) =>
    event.preventDefault(),
  );
  return window;
}

function configureWebImportSession(
  scanSession: Session,
  signal: AbortSignal,
  dnsLookup: WebImportDnsLookup,
): void {
  scanSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  scanSession.setPermissionCheckHandler(() => false);
  scanSession.on("will-download", (event) => event.preventDefault());
  scanSession.webRequest.onBeforeRequest((details, callback) => {
    if (signal.aborted) {
      callback({ cancel: true });
      return;
    }
    void isAllowedWebImportRequest(details.url, dnsLookup)
      .then((allowed) => callback({ cancel: !allowed }))
      .catch(() => callback({ cancel: true }));
  });
}

async function loadWebImportPage({
  deadlineAt,
  dnsLookup,
  requestedUrl,
  signal,
  window,
}: {
  deadlineAt: number;
  dnsLookup: WebImportDnsLookup;
  requestedUrl: string;
  signal: AbortSignal;
  window: BrowserWindow;
}): Promise<URL> {
  await waitForWebImportStep(window.loadURL(requestedUrl), deadlineAt, signal);
  return await waitForWebImportStep(
    assertPublicWebImportUrl(window.webContents.getURL(), dnsLookup),
    deadlineAt,
    signal,
  );
}

export function createSessionDnsLookup(
  scanSession: WebImportHostResolver,
): WebImportDnsLookup {
  const cache = new Map<
    string,
    Promise<readonly { address: string; family: number }[]>
  >();
  return (hostname) => {
    const normalized = hostname.toLowerCase();
    const existing = cache.get(normalized);
    if (existing) return existing;
    const pending = scanSession
      .resolveHost(normalized, { cacheUsage: "allowed" })
      .then(({ endpoints }) =>
        endpoints.flatMap((endpoint) => {
          const family =
            endpoint.family === "ipv4" ? 4 : endpoint.family === "ipv6" ? 6 : 0;
          return family === 0 ? [] : [{ address: endpoint.address, family }];
        }),
      );
    cache.set(normalized, pending);
    return pending;
  };
}

async function waitForWebImportStep<T>(
  operation: Promise<T>,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new WebImportDeadlineError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WebImportDeadlineError()), remaining);
    onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Web import cancelled", "AbortError"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, guard]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function throwIfDeadlineExceeded(deadlineAt: number): void {
  if (Date.now() >= deadlineAt) {
    throw new WebImportDeadlineError();
  }
}

function toPublicCandidate(
  sessionId: string,
): (candidate: StagedWebImportCandidate) => WebImportCandidate {
  return (candidate) => ({
    id: candidate.id,
    previewUrl: `mgt-import-preview://${sessionId}/${candidate.id}`,
    width: candidate.width,
    height: candidate.height,
    pixelCount: candidate.pixelCount,
    byteSize: candidate.byteSize,
    format: candidate.sourceFormat,
    storedExtension: candidate.storedExtension,
    pageIndex: candidate.pageIndex,
  });
}

function emitProgress(
  onProgress: (event: WebImportProgressEvent) => void,
  requestId: string,
  stage: WebImportProgressEvent["stage"],
  completed: number,
  total: number,
): void {
  onProgress({ requestId, stage, completed, total });
}

function sanitizePageTitle(title: string): string {
  return title
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 240);
}

function destroyWindow(window: BrowserWindow | null): void {
  if (window && !window.isDestroyed()) {
    window.destroy();
  }
}

class WebImportDeadlineError extends Error {}

export function isWebImportDeadlineError(error: unknown): boolean {
  return error instanceof WebImportDeadlineError;
}
