/* eslint-disable max-lines, complexity, max-lines-per-function -- the serialized scheduler keeps cancellation, publication, retry, and recovery transitions together for auditability */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { app, shell, type BrowserWindow } from "electron";
import { removeArtifactAfterFailure } from "../artifactCleanup";
import type { ActiveJobStore } from "../jobs/activeJob";
import type { ImageDecodeFallback } from "../regionCrop";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type {
  ConnectLinkedWorkspaceRequest,
  LinkedWorkspaceActivityRequest,
  LinkedSyncQueueItemV1,
  LinkedWorkspaceDestinationKind,
  LinkedWorkspaceRecordV1,
  LinkedWorkspaceStatus,
  UpdateLinkedWorkspaceRequest,
  ViewLinkedResultsRequest,
  ViewLinkedResultsResult,
} from "../../shared/linkedWorkspaceTypes";
import {
  createPageRevision,
  createPageVisualRevision,
} from "../../shared/pageRevision";
import { ipcEventContracts } from "../../shared/ipcEventContracts";
import type { listLibrary, openChapter } from "../library/libraryReadFacade";
import type { updatePagesAfterInpainting } from "../library/libraryMutationFacade";
import { unlinkIfExists } from "../libraryStore/storage";
import type {
  createPageExportRenderSession,
  PageExportRenderSession,
} from "../pageExport";
import {
  buildLinkedMirrorFileName,
  cleanupLinkedWorkspaceTemporaryFiles,
  copyFileAtomically,
  normalizeLinkedRelativePath,
  relativePathFromRoot,
  resolveLinkedPngArtifactPath,
  resolveLinkedResultPath,
  resolvePathInside,
  writeBinaryFileAtomically,
} from "./linkedWorkspacePaths";
import {
  countLinkedWorkspaceConflicts,
  fingerprintBuffer,
  fingerprintFile,
  type LinkedMirrorArtifact,
  type LinkedMirrorChapter,
  writeLinkedWorkspaceMirror,
} from "./linkedWorkspaceFiles";
import { LinkedWorkspaceStore } from "./linkedWorkspaceStore";
import { deriveLegacyInpaintMask } from "../inpainting/inpaintMaskArtifact";

const IDLE_DELAY_MS = 3_000;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000] as const;
const SESSION_IDLE_CLOSE_MS = 30_000;

type ServiceOptions = {
  dataRoot: string;
  jobs: ActiveJobStore;
  decodeImage: ImageDecodeFallback;
  getMainWindow: () => BrowserWindow | null;
  reportError: (message: string, detail?: unknown) => void;
  dependencies: ServiceDependencies;
};

type ServiceDependencies = {
  listLibrary: typeof listLibrary;
  openChapter: typeof openChapter;
  updatePagesAfterInpainting: typeof updatePagesAfterInpainting;
  createPageExportRenderSession: typeof createPageExportRenderSession;
};

type DrainWaiter = {
  connectionId: string;
  initialCount: number;
  resolve: (result: ViewLinkedResultsResult) => void;
};

export class LinkedWorkspaceSyncService {
  private readonly store: LinkedWorkspaceStore;
  private readonly options: ServiceOptions;
  private readonly dependencies: ServiceDependencies;
  private records = new Map<string, LinkedWorkspaceRecordV1>();
  private queue = new Map<string, LinkedSyncQueueItemV1>();
  private lastErrors = new Map<string, string>();
  private notices = new Map<string, string>();
  private forceConnections = new Set<string>();
  private forceRequestedAt = new Map<string, number>();
  private activeInteractions = new Set<"pointer" | "composition">();
  private drainWaiters: DrainWaiter[] = [];
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private queuePersistTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private renderSession: PageExportRenderSession | null = null;
  private activeDrainPromise: Promise<void> | null = null;
  private running = false;
  private activeConnection: string | null = null;
  private disposed = false;
  private generation = 0;
  private lastActivityAt = Date.now();

  constructor(options: ServiceOptions) {
    this.options = options;
    this.dependencies = options.dependencies;
    this.store = new LinkedWorkspaceStore(options.dataRoot);
  }

  async initialize(): Promise<void> {
    const [registry, queue] = await Promise.all([
      this.store.readRegistry(),
      this.store.readQueue(),
    ]);
    this.records = new Map(
      registry.records.map((record) => [record.id, record]),
    );
    this.queue = new Map(
      queue.items
        .filter((item) => this.records.has(item.connectionId))
        .map((item) => [queueKey(item.chapterId, item.pageId), item]),
    );
    await this.cleanupInterruptedWrites();
    await this.reconcilePersistedRecords();
    await this.persistQueue();
    this.emitStatuses();
    this.schedule(IDLE_DELAY_MS);
  }

  getStatus(chapterId: string): LinkedWorkspaceStatus {
    const record = this.findRecordByChapter(chapterId);
    if (!record) return unlinkedStatus(chapterId);
    const items = [...this.queue.values()].filter(
      (item) => item.connectionId === record.id,
    );
    const pendingCount = items.length;
    const failedCount = items.filter(
      (item) => item.attempts >= RETRY_DELAYS_MS.length,
    ).length;
    const lastError = this.lastErrors.get(record.id);
    const state = !record.enabled
      ? "disabled"
      : this.running && this.activeConnection === record.id
        ? "syncing"
        : failedCount > 0 || lastError
          ? "failed"
          : pendingCount > 0
            ? "pending"
            : "idle";
    return {
      chapterId,
      connectionId: record.id,
      state,
      pendingCount,
      failedCount,
      rootPath: record.rootPath,
      rootName: basename(record.rootPath),
      destinationKind: record.destinationKind ?? "managed",
      outputFormat: record.output.format,
      ...(this.notices.get(record.id)
        ? { notice: this.notices.get(record.id) }
        : {}),
      ...(lastError ? { lastError } : {}),
    };
  }

  listStatuses(): LinkedWorkspaceStatus[] {
    return [...this.records.values()].map((record) =>
      this.getStatus(record.chapterId),
    );
  }

  async connect(
    request: ConnectLinkedWorkspaceRequest,
  ): Promise<LinkedWorkspaceStatus> {
    const chapter = await this.dependencies.openChapter(request.chapterId);
    if (chapter.workId !== request.workId) {
      throw new Error("선택한 작품과 화가 일치하지 않습니다.");
    }
    const destinationKind: LinkedWorkspaceDestinationKind = request.rootPath
      ? "custom"
      : "managed";
    const rootPath = request.rootPath
      ? resolve(request.rootPath)
      : await this.resolveManagedRoot(chapter);
    await assertOrCreateDestinationDirectory(rootPath, destinationKind);
    const current = this.findRecordByChapter(chapter.id);
    const sameRoot = current ? sameFilePath(current.rootPath, rootPath) : false;
    const pageRelativePaths = resolveOutputRelativePaths(chapter);
    const { sourceFingerprints, sourceRelativePaths } =
      await materializeRecoverySources({
        chapter,
        pageRelativePaths,
        rootPath,
      });
    const now = new Date().toISOString();
    const record: LinkedWorkspaceRecordV1 = {
      id: current?.id ?? randomUUID(),
      workId: chapter.workId,
      chapterId: chapter.id,
      rootPath,
      destinationKind,
      enabled: true,
      output: request.output,
      pageRelativePaths,
      sourceRelativePaths,
      publishedRevisions: sameRoot ? (current?.publishedRevisions ?? {}) : {},
      publishedMirrorRevisions: sameRoot
        ? (current?.publishedMirrorRevisions ?? {})
        : {},
      sourceFingerprints,
      artifacts: sameRoot ? (current?.artifacts ?? {}) : {},
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.reportActivity({ type: "pulse" });
    this.records.set(record.id, record);
    await this.store.replaceRecord(record);
    this.lastErrors.delete(record.id);
    this.notices.delete(record.id);
    if (request.enqueueExistingPages) {
      await this.queuePages(chapter.id, chapter.pageOrder, {
        immediate: true,
        priority: 50,
      });
    } else {
      await this.queueMirrorOnly(chapter, record);
    }
    this.emitStatuses();
    return this.getStatus(chapter.id);
  }

  async update(
    request: UpdateLinkedWorkspaceRequest,
  ): Promise<LinkedWorkspaceStatus> {
    const current = this.records.get(request.connectionId);
    if (!current) throw new Error("자동 저장 설정을 찾지 못했습니다.");
    const outputChanged =
      request.output !== undefined &&
      JSON.stringify(request.output) !== JSON.stringify(current.output);
    const record: LinkedWorkspaceRecordV1 = {
      ...current,
      ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
      ...(request.output ? { output: request.output } : {}),
      ...(outputChanged ? { publishedRevisions: {} } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.reportActivity({ type: "pulse" });
    this.records.set(record.id, record);
    await this.store.replaceRecord(record);
    if (!record.enabled) {
      this.forceConnections.delete(record.id);
      this.forceRequestedAt.delete(record.id);
      this.resolveDrainWaiters(record.id, { status: "cancelled" });
    }
    if (record.enabled && outputChanged) {
      const chapter = await this.dependencies.openChapter(record.chapterId);
      await this.queuePages(record.chapterId, chapter.pageOrder, {
        immediate: true,
        priority: 40,
      });
    } else if (record.enabled) {
      this.schedule(0);
    }
    this.emitStatuses();
    return this.getStatus(record.chapterId);
  }

  async reconnect(
    connectionId: string,
    rootPath: string,
  ): Promise<LinkedWorkspaceStatus> {
    const current = this.records.get(connectionId);
    if (!current) throw new Error("자동 저장 설정을 찾지 못했습니다.");
    return this.connect({
      workId: current.workId,
      chapterId: current.chapterId,
      rootPath,
      destinationKind: "custom",
      output: current.output,
      enqueueExistingPages: true,
    });
  }

  async resetToManaged(connectionId: string): Promise<LinkedWorkspaceStatus> {
    const current = this.records.get(connectionId);
    if (!current) throw new Error("자동 저장 설정을 찾지 못했습니다.");
    return this.connect({
      workId: current.workId,
      chapterId: current.chapterId,
      destinationKind: "managed",
      output: current.output,
      enqueueExistingPages: true,
    });
  }

  async disconnect(connectionId: string): Promise<boolean> {
    this.reportActivity({ type: "pulse" });
    const removed = await this.store.removeRecord(connectionId);
    if (!removed) return false;
    const record = this.records.get(connectionId);
    this.records.delete(connectionId);
    this.lastErrors.delete(connectionId);
    this.notices.delete(connectionId);
    this.forceConnections.delete(connectionId);
    this.forceRequestedAt.delete(connectionId);
    for (const [key, item] of this.queue) {
      if (item.connectionId === connectionId) this.queue.delete(key);
    }
    await this.persistQueue();
    if (record) this.resolveDrainWaiters(connectionId, { status: "cancelled" });
    this.emitStatuses();
    return true;
  }

  async countConflicts(rootPath: string): Promise<number> {
    return countLinkedWorkspaceConflicts(rootPath);
  }

  private async resolveManagedRoot(chapter: ChapterSnapshot): Promise<string> {
    const current = this.findRecordByChapter(chapter.id);
    if (current?.destinationKind === "managed") return current.rootPath;
    const library = await this.dependencies.listLibrary();
    const workTitle =
      library.works.find((work) => work.id === chapter.workId)?.title ??
      "새 작품";
    const workDirectory = safeResultPathSegment(workTitle, "작품");
    const chapterDirectory = safeResultPathSegment(chapter.title, "화");
    const preferred = join(
      this.options.dataRoot,
      "results",
      workDirectory,
      chapterDirectory,
    );
    for (let suffix = 1; ; suffix += 1) {
      const candidate = suffix === 1 ? preferred : `${preferred} (${suffix})`;
      const usedByAnotherChapter = [...this.records.values()].some(
        (record) =>
          record.chapterId !== chapter.id &&
          sameFilePath(record.rootPath, candidate),
      );
      if (usedByAnotherChapter) continue;
      const ownership = await inspectManagedDestination(candidate, chapter.id);
      if (ownership !== "occupied") return candidate;
    }
  }

  async notifyPagesSaved(
    chapterId: string,
    pageIds: readonly string[],
    options: { immediate?: boolean; priority?: number } = {},
  ): Promise<void> {
    await this.queuePages(chapterId, pageIds, options);
  }

  reportActivity(request: LinkedWorkspaceActivityRequest): void {
    if (request.type === "start") {
      this.activeInteractions.add(request.interaction);
    } else if (request.type === "end") {
      this.activeInteractions.delete(request.interaction);
    }
    this.lastActivityAt = Date.now();
    this.generation += 1;
    if (this.renderSession && this.running) {
      try {
        this.renderSession.cancel?.();
      } catch (error) {
        this.options.reportError(
          "Failed to cancel linked workspace render",
          error,
        );
      } finally {
        this.renderSession = null;
      }
    }
    this.schedule(IDLE_DELAY_MS);
  }

  async viewResults(
    request: ViewLinkedResultsRequest,
  ): Promise<ViewLinkedResultsResult> {
    const record = this.findRecordByChapter(request.chapterId);
    if (!record) {
      return {
        status: "failed",
        message: "이 화에 저장된 자동 결과물이 없습니다.",
      };
    }
    if (!record.enabled) return this.openResultDirectory(record, 0);
    const chapter = await this.dependencies.openChapter(request.chapterId);
    await this.queuePages(chapter.id, chapter.pageOrder, {
      immediate: true,
      priority: 60,
      currentPageId: request.currentPageId,
      ensurePublishedOutput: true,
    });
    const pending = this.pendingCount(record.id);
    if (pending === 0) return this.openResultDirectory(record, 0);
    this.forceConnections.add(record.id);
    this.forceRequestedAt.set(record.id, Date.now());
    this.schedule(0);
    return new Promise<ViewLinkedResultsResult>((resolveResult) => {
      this.drainWaiters.push({
        connectionId: record.id,
        initialCount: pending,
        resolve: resolveResult,
      });
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearTimers();
    this.generation += 1;
    if (this.renderSession) {
      try {
        this.renderSession.cancel?.();
      } catch (error) {
        this.options.reportError(
          "Failed to stop linked workspace renderer",
          error,
        );
      }
      this.renderSession = null;
    }
    if (this.activeDrainPromise) {
      await waitForSettled(this.activeDrainPromise, 1_500);
    }
    await this.persistQueue();
    for (const waiter of this.drainWaiters.splice(0)) {
      waiter.resolve({ status: "cancelled" });
    }
  }

  private async queuePages(
    chapterId: string,
    pageIds: readonly string[],
    options: {
      immediate?: boolean;
      priority?: number;
      currentPageId?: string;
      ensurePublishedOutput?: boolean;
    } = {},
  ): Promise<void> {
    const record = this.findRecordByChapter(chapterId);
    if (!record || !record.enabled) return;
    const chapter = await this.dependencies.openChapter(chapterId);
    const requested = new Set(pageIds);
    const now = Date.now();
    let recordChanged = false;
    for (const page of chapter.pages) {
      if (!requested.has(page.id)) continue;
      const visualRevision = createPageVisualRevision(page);
      const mirrorRevision = createPageRevision(page);
      const artifactState = options.ensurePublishedOutput
        ? await inspectPageArtifacts(record, page)
        : null;
      if (artifactState && !artifactState.resultCurrent) {
        delete record.publishedRevisions[page.id];
        recordChanged = true;
      }
      const artifactsCurrent = artifactState
        ? Object.values(artifactState).every(Boolean)
        : true;
      if (
        record.publishedRevisions[page.id] === visualRevision &&
        record.publishedMirrorRevisions[page.id] === mirrorRevision &&
        artifactsCurrent
      ) {
        this.queue.delete(queueKey(chapterId, page.id));
        continue;
      }
      const previous = this.queue.get(queueKey(chapterId, page.id));
      const preserveMirrorOnly =
        options.ensurePublishedOutput !== true &&
        previous?.mirrorOnly === true &&
        previous.visualRevision === visualRevision;
      this.queue.set(queueKey(chapterId, page.id), {
        connectionId: record.id,
        chapterId,
        pageId: page.id,
        visualRevision,
        mirrorRevision,
        priority:
          page.id === options.currentPageId
            ? 100
            : Math.max(previous?.priority ?? 0, options.priority ?? 10),
        attempts:
          options.immediate && (options.priority ?? 0) >= 60
            ? 0
            : previous?.visualRevision === visualRevision
              ? previous.attempts
              : 0,
        nextRetryAt: options.immediate ? 0 : now + IDLE_DELAY_MS,
        queuedAt: now,
        ...(preserveMirrorOnly ? { mirrorOnly: true } : {}),
      });
    }
    if (recordChanged) await this.store.replaceRecord(record);
    this.scheduleQueuePersist();
    this.emitStatuses();
    this.schedule(options.immediate ? 0 : IDLE_DELAY_MS);
  }

  private async queueMirrorOnly(
    chapter: ChapterSnapshot,
    record: LinkedWorkspaceRecordV1,
  ): Promise<void> {
    for (const page of chapter.pages) {
      const visualRevision = createPageVisualRevision(page);
      this.queue.set(queueKey(chapter.id, page.id), {
        connectionId: record.id,
        chapterId: chapter.id,
        pageId: page.id,
        visualRevision,
        mirrorRevision: createPageRevision(page),
        priority: 5,
        attempts: 0,
        nextRetryAt: Date.now() + IDLE_DELAY_MS,
        queuedAt: Date.now(),
        mirrorOnly: true,
      });
    }
    await this.store.replaceRecord(record);
    this.scheduleQueuePersist();
    this.schedule(IDLE_DELAY_MS);
  }

  private schedule(delayMs: number): void {
    if (this.disposed) return;
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = setTimeout(
      () => {
        this.scheduleTimer = null;
        const drain = this.drain();
        this.activeDrainPromise = drain;
        void drain
          .catch((error: unknown) => {
            this.options.reportError("Linked workspace queue failed", error);
          })
          .finally(() => {
            if (this.activeDrainPromise === drain)
              this.activeDrainPromise = null;
          });
      },
      Math.max(0, delayMs),
    );
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.running) return;
    if (this.activeInteractions.size > 0) {
      this.schedule(250);
      return;
    }
    if (this.options.jobs.hasActive) {
      this.schedule(500);
      return;
    }
    const item = this.nextReadyItem();
    if (!item) {
      this.finishDrainedConnections();
      this.scheduleNextRetry();
      return;
    }
    const forced = this.forceConnections.has(item.connectionId);
    const bypassIdle =
      forced &&
      this.lastActivityAt <=
        (this.forceRequestedAt.get(item.connectionId) ?? 0);
    const remainingIdle = IDLE_DELAY_MS - (Date.now() - this.lastActivityAt);
    if (!bypassIdle && remainingIdle > 0) {
      this.schedule(remainingIdle);
      return;
    }
    this.running = true;
    this.activeConnection = item.connectionId;
    const generation = this.generation;
    this.emitStatuses();
    try {
      await this.processItem(item, generation);
      if (this.isCurrentQueueItem(item)) {
        this.queue.delete(queueKey(item.chapterId, item.pageId));
      }
      this.lastErrors.delete(item.connectionId);
    } catch (error) {
      if (this.isCurrentQueueItem(item)) {
        if (
          generation !== this.generation ||
          this.options.jobs.hasActive ||
          isAbortError(error)
        ) {
          item.nextRetryAt = Date.now() + IDLE_DELAY_MS;
        } else {
          this.registerFailure(item, error);
        }
        this.queue.set(queueKey(item.chapterId, item.pageId), item);
      }
    } finally {
      this.running = false;
      this.activeConnection = null;
      this.scheduleQueuePersist();
      this.emitStatuses();
      this.scheduleSessionClose();
    }
    this.schedule(0);
  }

  private nextReadyItem(): LinkedSyncQueueItemV1 | null {
    const now = Date.now();
    return (
      [...this.queue.values()]
        .filter((item) => {
          const record = this.records.get(item.connectionId);
          return (
            record?.enabled === true &&
            item.attempts < RETRY_DELAYS_MS.length &&
            item.nextRetryAt <= now
          );
        })
        .sort(
          (left, right) =>
            right.priority - left.priority || left.queuedAt - right.queuedAt,
        )[0] ?? null
    );
  }

  private async processItem(
    item: LinkedSyncQueueItemV1,
    generation: number,
  ): Promise<void> {
    const record = this.records.get(item.connectionId);
    if (!record) throw new Error("연결 정보가 사라졌습니다.");
    await this.assertSourceUnchanged(record, item.pageId);
    const chapter = await this.dependencies.openChapter(item.chapterId);
    const page = chapter.pages.find(
      (candidate) => candidate.id === item.pageId,
    );
    if (!page) throw new Error("동기화할 페이지를 찾지 못했습니다.");
    assertExpectedRevision(page, item);
    this.assertGeneration(generation);
    if (await this.persistLegacyMaskIfNeeded(chapter, page, generation)) {
      await this.queuePages(chapter.id, [page.id], {
        immediate: true,
        priority: item.priority,
      });
      return;
    }

    const needsRender =
      item.mirrorOnly !== true &&
      record.publishedRevisions[page.id] !== item.visualRevision;
    if (needsRender) {
      const result = resolveLinkedResultPath({
        rootPath: record.rootPath,
        sourceRelativePath: this.pageRelativePath(record, page),
        format: record.output.format,
      });
      const session = await this.getRenderSession();
      const content = await session.renderPage(page, {
        format: result.captureFormat,
        resolutionMode: "original",
        ...(result.captureFormat === "jpeg"
          ? { quality: record.output.jpegQuality }
          : result.captureFormat === "webp"
            ? { quality: record.output.webpQuality }
            : {}),
      });
      this.assertGeneration(generation);
      const latest = await this.dependencies.openChapter(item.chapterId);
      const latestPage = latest.pages.find(
        (candidate) => candidate.id === item.pageId,
      );
      if (
        !latestPage ||
        createPageVisualRevision(latestPage) !== item.visualRevision
      ) {
        throw new Error("렌더링 중 페이지가 변경되었습니다.");
      }
      const previousResult = record.artifacts[page.id]?.result;
      await writeBinaryFileAtomically(result.path, content, () =>
        this.assertGeneration(generation),
      );
      record.artifacts[page.id] = {
        ...record.artifacts[page.id],
        result: artifactFromBuffer(record.rootPath, result.path, content),
      };
      record.publishedRevisions[page.id] = item.visualRevision;
      if (
        previousResult &&
        normalizeLinkedRelativePath(previousResult.path).toLowerCase() !==
          relativePathFromRoot(record.rootPath, result.path).toLowerCase()
      ) {
        await unlinkIfExists(
          resolvePathInside(record.rootPath, previousResult.path),
        );
      }
    }
    this.assertGeneration(generation);
    await this.publishInpaintingArtifacts(record, page, generation);
    this.assertGeneration(generation);
    record.updatedAt = new Date().toISOString();
    this.records.set(record.id, record);
    await this.store.replaceRecord(record);
    if (!this.hasOtherPendingRootItem(record.rootPath, item)) {
      const published = await this.writeMirrorForRoot(
        record.rootPath,
        generation,
      );
      await this.markMirrorSnapshotPublished(published);
    }
  }

  private async publishInpaintingArtifacts(
    record: LinkedWorkspaceRecordV1,
    page: MangaPage,
    generation: number,
  ): Promise<void> {
    const sourceRelativePath = this.pageRelativePath(record, page);
    const disambiguate = hasStemCollision(record, page.id, sourceRelativePath);
    const previous = record.artifacts[page.id] ?? {};
    const next = { ...previous };
    if (page.inpaintedImagePath) {
      const targetPath = resolveLinkedPngArtifactPath({
        rootPath: record.rootPath,
        directory: "inpainted",
        sourceRelativePath,
        disambiguateExtension: disambiguate,
      });
      if (
        !(await canReusePublishedArtifact({
          artifact: previous.inpainted,
          rootPath: record.rootPath,
          sourcePath: page.inpaintedImagePath,
          targetPath,
        }))
      ) {
        await copyFileAtomically(page.inpaintedImagePath, targetPath, () =>
          this.assertGeneration(generation),
        );
        this.assertGeneration(generation);
        next.inpainted = {
          ...(await artifactFromFile(record.rootPath, targetPath)),
          sourcePath: page.inpaintedImagePath,
        };
        await removeReplacedArtifact(
          record.rootPath,
          previous.inpainted,
          next.inpainted.path,
          () => this.assertGeneration(generation),
        );
      }
    } else {
      await removeReplacedArtifact(
        record.rootPath,
        previous.inpainted,
        null,
        () => this.assertGeneration(generation),
      );
      delete next.inpainted;
    }
    if (page.inpaintMaskPath) {
      const targetPath = resolveLinkedPngArtifactPath({
        rootPath: record.rootPath,
        directory: "mask",
        sourceRelativePath,
        disambiguateExtension: disambiguate,
      });
      if (
        !(await canReusePublishedArtifact({
          artifact: previous.mask,
          rootPath: record.rootPath,
          sourcePath: page.inpaintMaskPath,
          targetPath,
        }))
      ) {
        await copyFileAtomically(page.inpaintMaskPath, targetPath, () =>
          this.assertGeneration(generation),
        );
        this.assertGeneration(generation);
        next.mask = {
          ...(await artifactFromFile(record.rootPath, targetPath)),
          sourcePath: page.inpaintMaskPath,
        };
        await removeReplacedArtifact(
          record.rootPath,
          previous.mask,
          next.mask.path,
          () => this.assertGeneration(generation),
        );
      }
    } else {
      await removeReplacedArtifact(record.rootPath, previous.mask, null, () =>
        this.assertGeneration(generation),
      );
      delete next.mask;
    }
    record.artifacts[page.id] = next;
  }

  private async persistLegacyMaskIfNeeded(
    chapter: ChapterSnapshot,
    page: MangaPage,
    generation: number,
  ): Promise<boolean> {
    if (!page.inpaintedImagePath || page.inpaintMaskPath) return false;
    const derived = await deriveLegacyInpaintMask({
      page,
      decodeFallback: this.options.decodeImage,
    });
    if (!derived) return false;
    try {
      this.assertGeneration(generation);
      await this.dependencies.updatePagesAfterInpainting(
        chapter.id,
        [
          {
            ...page,
            inpaintMaskPath: derived.path,
            maskProvenance: derived.provenance,
            updatedAt: new Date().toISOString(),
          },
        ],
        {
          expectedTargets: [
            {
              chapterId: chapter.id,
              pageId: page.id,
              revision: createPageRevision(page),
            },
          ],
        },
      );
      return true;
    } catch (error) {
      return removeArtifactAfterFailure(derived.path, error);
    }
  }

  private async assertSourceUnchanged(
    record: LinkedWorkspaceRecordV1,
    pageId: string,
  ): Promise<void> {
    const relativePath = this.sourceRelativePath(record, pageId);
    const expected = record.sourceFingerprints[pageId];
    if (!relativePath || !expected) {
      await this.fallbackToManagedDestination(
        record,
        "자동 저장용 원본 복사본을 다시 만들었습니다.",
      );
      throw new DOMException("Recovered missing source copy", "AbortError");
    }
    const sourcePath = resolvePathInside(record.rootPath, relativePath);
    try {
      const metadata = await stat(sourcePath);
      if (
        metadata.isFile() &&
        metadata.size === expected.size &&
        Math.abs(metadata.mtimeMs - expected.mtimeMs) < 1
      ) {
        return;
      }
      const actual = await fingerprintFile(sourcePath);
      if (actual.sha256 !== expected.sha256) {
        await this.fallbackToManagedDestination(
          record,
          "지정한 저장 위치의 원본 복사본이 변경되어 기본 결과물 폴더로 전환했습니다.",
        );
        throw new DOMException("Recovered changed source copy", "AbortError");
      }
      if (
        actual.size !== expected.size ||
        Math.abs(actual.mtimeMs - expected.mtimeMs) >= 1
      ) {
        record.sourceFingerprints[pageId] = actual;
        await this.store.replaceRecord(record);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      await this.fallbackToManagedDestination(
        record,
        "지정한 저장 위치를 사용할 수 없어 기본 결과물 폴더로 전환했습니다.",
      );
      throw new DOMException("Recovered unavailable destination", "AbortError");
    }
  }

  private async fallbackToManagedDestination(
    record: LinkedWorkspaceRecordV1,
    notice: string,
  ): Promise<void> {
    const chapter = await this.dependencies.openChapter(record.chapterId);
    const rootPath = await this.resolveManagedRoot(chapter);
    await assertOrCreateDestinationDirectory(rootPath, "managed");
    const pageRelativePaths = resolveOutputRelativePaths(chapter);
    const { sourceFingerprints, sourceRelativePaths } =
      await materializeRecoverySources({
        chapter,
        pageRelativePaths,
        rootPath,
      });
    record.rootPath = rootPath;
    record.destinationKind = "managed";
    record.pageRelativePaths = pageRelativePaths;
    record.sourceRelativePaths = sourceRelativePaths;
    record.sourceFingerprints = sourceFingerprints;
    record.publishedRevisions = {};
    record.publishedMirrorRevisions = {};
    record.artifacts = {};
    record.updatedAt = new Date().toISOString();
    this.records.set(record.id, record);
    this.lastErrors.delete(record.id);
    this.notices.set(record.id, notice);
    await this.store.replaceRecord(record);
    await this.queuePages(chapter.id, chapter.pageOrder, {
      priority: 40,
    });
    this.emitStatuses();
  }

  private async getRenderSession(): Promise<PageExportRenderSession> {
    if (this.sessionCloseTimer) {
      clearTimeout(this.sessionCloseTimer);
      this.sessionCloseTimer = null;
    }
    this.renderSession ??=
      await this.dependencies.createPageExportRenderSession({
        dataRoot: this.options.dataRoot,
        decodeFallback: this.options.decodeImage,
        lowPriority: true,
      });
    return this.renderSession;
  }

  private scheduleSessionClose(): void {
    if (!this.renderSession || this.sessionCloseTimer) return;
    this.sessionCloseTimer = setTimeout(() => {
      this.sessionCloseTimer = null;
      if (this.running || !this.renderSession) return;
      try {
        this.renderSession.close();
      } catch (error) {
        this.options.reportError(
          "Failed to close linked workspace renderer",
          error,
        );
      } finally {
        this.renderSession = null;
      }
    }, SESSION_IDLE_CLOSE_MS);
  }

  private async writeMirrorForRoot(
    rootPath: string,
    generation: number,
  ): Promise<Array<{ recordId: string; pageId: string; revision: string }>> {
    const records = [...this.records.values()].filter(
      (record) =>
        normalizeRootKey(record.rootPath) === normalizeRootKey(rootPath),
    );
    const chapters: LinkedMirrorChapter[] = [];
    const published: Array<{
      recordId: string;
      pageId: string;
      revision: string;
    }> = [];
    const library = await this.dependencies.listLibrary();
    const workTitles = new Map(
      library.works.map((work) => [work.id, work.title]),
    );
    for (const record of records) {
      const chapter = await this.dependencies.openChapter(record.chapterId);
      for (const page of chapter.pages) {
        published.push({
          recordId: record.id,
          pageId: page.id,
          revision: createPageRevision(page),
        });
      }
      chapters.push({
        id: chapter.id,
        workId: chapter.workId,
        workTitle: workTitles.get(chapter.workId) ?? basename(rootPath),
        title: chapter.title,
        output: record.output,
        pages: chapter.pages.map((page) => ({
          id: page.id,
          name: page.name,
          width: page.width,
          height: page.height,
          blocks: page.blocks,
          blockOrder: page.blockOrder,
          translationCompletion: page.translationCompletion,
          maskProvenance: page.maskProvenance,
          sourceRelativePath:
            this.sourceRelativePath(record, page.id) ??
            this.pageRelativePath(record, page),
          source: sourceArtifactFromRecord(
            record,
            page.id,
            this.sourceRelativePath(record, page.id) ??
              this.pageRelativePath(record, page),
          ),
          ...toMirrorArtifacts(record.artifacts[page.id]),
        })),
      });
    }
    await writeLinkedWorkspaceMirror({
      rootPath,
      appVersion: app.getVersion(),
      chapters,
      beforeCommit: () => this.assertGeneration(generation),
    });
    return published;
  }

  private async markMirrorSnapshotPublished(
    published: Array<{ recordId: string; pageId: string; revision: string }>,
  ): Promise<void> {
    const changedRecords = new Set<string>();
    for (const item of published) {
      const record = this.records.get(item.recordId);
      if (!record) continue;
      record.publishedMirrorRevisions[item.pageId] = item.revision;
      record.updatedAt = new Date().toISOString();
      changedRecords.add(record.id);
    }
    for (const recordId of changedRecords) {
      const record = this.records.get(recordId);
      if (record) await this.store.replaceRecord(record);
    }
  }

  private hasOtherPendingRootItem(
    rootPath: string,
    current: LinkedSyncQueueItemV1,
  ): boolean {
    return [...this.queue.values()].some((item) => {
      if (
        item.chapterId === current.chapterId &&
        item.pageId === current.pageId
      ) {
        return false;
      }
      const record = this.records.get(item.connectionId);
      return (
        record?.enabled === true &&
        normalizeRootKey(record.rootPath) === normalizeRootKey(rootPath) &&
        item.attempts < RETRY_DELAYS_MS.length
      );
    });
  }

  private async reconcilePersistedRecords(): Promise<void> {
    const now = Date.now();
    const missingMirrors = new Map<string, boolean>();
    recordLoop: for (const record of this.records.values()) {
      let chapter: ChapterSnapshot;
      try {
        chapter = await this.dependencies.openChapter(record.chapterId);
      } catch (error) {
        this.lastErrors.set(
          record.id,
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }
      if (!record.destinationKind) {
        await this.fallbackToManagedDestination(
          record,
          "이전 자동 저장 설정을 기본 결과물 폴더로 옮겼습니다.",
        );
        continue;
      }
      let recordChanged = false;
      for (const page of chapter.pages) {
        const sourceState = await inspectConnectedSource(record, page.id);
        if (sourceState === "changed") {
          await this.fallbackToManagedDestination(
            record,
            "지정한 저장 위치를 사용할 수 없어 기본 결과물 폴더로 전환했습니다.",
          );
          continue recordLoop;
        }
        if (sourceState) {
          record.sourceFingerprints[page.id] = sourceState;
          recordChanged = true;
        }
      }
      const rootKey = normalizeRootKey(record.rootPath);
      let mirrorMissing = missingMirrors.get(rootKey);
      if (mirrorMissing === undefined) {
        mirrorMissing = !(await fileExists(
          resolvePathInside(
            record.rootPath,
            buildLinkedMirrorFileName(record.rootPath),
          ),
        ));
        missingMirrors.set(rootKey, mirrorMissing);
      }
      for (const page of chapter.pages) {
        const visualRevision = createPageVisualRevision(page);
        const mirrorRevision = createPageRevision(page);
        const artifacts = record.artifacts[page.id];
        const resultMissing = record.publishedRevisions[page.id]
          ? !(await publishedArtifactExists(record.rootPath, artifacts?.result))
          : false;
        const inpaintedStale = page.inpaintedImagePath
          ? !(await reusableSourceArtifactExists(
              record.rootPath,
              artifacts?.inpainted,
              page.inpaintedImagePath,
            ))
          : Boolean(artifacts?.inpainted);
        const maskStale = page.inpaintMaskPath
          ? !(await reusableSourceArtifactExists(
              record.rootPath,
              artifacts?.mask,
              page.inpaintMaskPath,
            ))
          : Boolean(artifacts?.mask);
        const visualStale =
          resultMissing ||
          inpaintedStale ||
          maskStale ||
          (Boolean(record.publishedRevisions[page.id]) &&
            record.publishedRevisions[page.id] !== visualRevision);
        const mirrorStale =
          mirrorMissing ||
          record.publishedMirrorRevisions[page.id] !== mirrorRevision;
        if (!visualStale && !mirrorStale) continue;
        const key = queueKey(chapter.id, page.id);
        if (this.queue.has(key)) continue;
        this.queue.set(key, {
          connectionId: record.id,
          chapterId: chapter.id,
          pageId: page.id,
          visualRevision,
          mirrorRevision,
          priority: 20,
          attempts: 0,
          nextRetryAt: now + IDLE_DELAY_MS,
          queuedAt: now,
          ...(!visualStale ? { mirrorOnly: true } : {}),
        });
      }
      if (recordChanged) await this.store.replaceRecord(record);
    }
  }

  private async cleanupInterruptedWrites(): Promise<void> {
    const roots = new Set(
      [...this.records.values()].map((record) =>
        normalizeRootKey(record.rootPath),
      ),
    );
    for (const rootPath of roots) {
      try {
        await cleanupLinkedWorkspaceTemporaryFiles(rootPath);
      } catch (error) {
        this.options.reportError(
          "Failed to clean interrupted linked workspace writes",
          error,
        );
      }
    }
  }

  private registerFailure(item: LinkedSyncQueueItemV1, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastErrors.set(item.connectionId, message);
    item.attempts += 1;
    item.nextRetryAt =
      item.attempts >= RETRY_DELAYS_MS.length
        ? Number.MAX_SAFE_INTEGER
        : Date.now() + RETRY_DELAYS_MS[item.attempts - 1];
    item.priority = Math.max(0, item.priority - 1);
  }

  private finishDrainedConnections(): void {
    for (const connectionId of [...this.forceConnections]) {
      if (this.pendingCount(connectionId) === 0) {
        this.forceConnections.delete(connectionId);
        this.forceRequestedAt.delete(connectionId);
        const record = this.records.get(connectionId);
        if (record) {
          void this.openResultDirectory(record, 0).then((result) =>
            this.resolveDrainWaiters(connectionId, result),
          );
        }
      } else if (this.hasTerminalFailure(connectionId)) {
        this.forceConnections.delete(connectionId);
        this.forceRequestedAt.delete(connectionId);
        this.resolveDrainWaiters(connectionId, {
          status: "failed",
          message:
            this.lastErrors.get(connectionId) ??
            "결과물 동기화에 실패했습니다.",
        });
      }
    }
  }

  private async openResultDirectory(
    record: LinkedWorkspaceRecordV1,
    syncedPages: number,
  ): Promise<ViewLinkedResultsResult> {
    const resultDirectory = resolvePathInside(
      record.rootPath,
      "result/.probe",
    ).replace(/[\\/]\.probe$/, "");
    await mkdir(resultDirectory, { recursive: true });
    const error = await shell.openPath(resultDirectory);
    return error
      ? { status: "failed", message: error }
      : { status: "opened", syncedPages };
  }

  private resolveDrainWaiters(
    connectionId: string,
    result: ViewLinkedResultsResult,
  ): void {
    const remaining: DrainWaiter[] = [];
    for (const waiter of this.drainWaiters) {
      if (waiter.connectionId !== connectionId) {
        remaining.push(waiter);
        continue;
      }
      waiter.resolve(
        result.status === "opened"
          ? { ...result, syncedPages: waiter.initialCount }
          : result,
      );
    }
    this.drainWaiters = remaining;
  }

  private findRecordByChapter(
    chapterId: string,
  ): LinkedWorkspaceRecordV1 | null {
    return (
      [...this.records.values()].find(
        (record) => record.chapterId === chapterId,
      ) ?? null
    );
  }

  private pageRelativePath(
    record: LinkedWorkspaceRecordV1,
    page: MangaPage,
  ): string {
    const value = record.pageRelativePaths[page.id];
    if (!value) throw new Error("페이지의 원본 상대 경로가 없습니다.");
    return value;
  }

  private sourceRelativePath(
    record: LinkedWorkspaceRecordV1,
    pageId: string,
  ): string | null {
    return (
      record.sourceRelativePaths?.[pageId] ??
      record.pageRelativePaths[pageId] ??
      null
    );
  }

  private pendingCount(connectionId: string): number {
    return [...this.queue.values()].filter(
      (item) => item.connectionId === connectionId,
    ).length;
  }

  private hasTerminalFailure(connectionId: string): boolean {
    return [...this.queue.values()].some(
      (item) =>
        item.connectionId === connectionId &&
        item.attempts >= RETRY_DELAYS_MS.length,
    );
  }

  private isCurrentQueueItem(item: LinkedSyncQueueItemV1): boolean {
    const current = this.queue.get(queueKey(item.chapterId, item.pageId));
    return (
      current?.visualRevision === item.visualRevision &&
      current.mirrorRevision === item.mirrorRevision
    );
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation || this.options.jobs.hasActive) {
      throw new DOMException("Aborted", "AbortError");
    }
  }

  private scheduleNextRetry(): void {
    const nextRetryAt = [...this.queue.values()]
      .filter((item) => {
        const record = this.records.get(item.connectionId);
        return (
          record?.enabled === true && item.attempts < RETRY_DELAYS_MS.length
        );
      })
      .reduce(
        (earliest, item) => Math.min(earliest, item.nextRetryAt),
        Number.POSITIVE_INFINITY,
      );
    if (Number.isFinite(nextRetryAt)) {
      this.schedule(Math.max(0, nextRetryAt - Date.now()));
    }
  }

  private scheduleQueuePersist(): void {
    if (this.queuePersistTimer) return;
    this.queuePersistTimer = setTimeout(() => {
      this.queuePersistTimer = null;
      void this.persistQueue().catch((error: unknown) =>
        this.options.reportError(
          "Failed to persist linked workspace queue",
          error,
        ),
      );
    }, 250);
  }

  private async persistQueue(): Promise<void> {
    await this.store.replaceQueueItems([...this.queue.values()]);
  }

  private emitStatuses(): void {
    const window = this.options.getMainWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(
      ipcEventContracts.linkedWorkspaceStatusChanged.channel,
      {
        statuses: this.listStatuses(),
      },
    );
  }

  private clearTimers(): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    if (this.queuePersistTimer) clearTimeout(this.queuePersistTimer);
    if (this.sessionCloseTimer) clearTimeout(this.sessionCloseTimer);
    this.scheduleTimer = null;
    this.queuePersistTimer = null;
    this.sessionCloseTimer = null;
  }
}

function unlinkedStatus(chapterId: string): LinkedWorkspaceStatus {
  return {
    chapterId,
    state: "unlinked",
    pendingCount: 0,
    failedCount: 0,
  };
}

function queueKey(chapterId: string, pageId: string): string {
  return `${chapterId}:${pageId}`;
}

function assertExpectedRevision(
  page: MangaPage,
  item: LinkedSyncQueueItemV1,
): void {
  if (
    createPageVisualRevision(page) !== item.visualRevision ||
    createPageRevision(page) !== item.mirrorRevision
  ) {
    throw new Error("대기열 등록 후 페이지가 변경되었습니다.");
  }
}

function resolveOutputRelativePaths(
  chapter: ChapterSnapshot,
): Record<string, string> {
  const result: Record<string, string> = {};
  const used = new Set<string>();
  for (const [index, page] of chapter.pages.entries()) {
    const candidates = [
      page.sourceRelativePath,
      page.sourceFileName,
      page.name,
    ].filter((value): value is string => Boolean(value));
    let relativePath: string | null = null;
    for (const candidate of candidates) {
      try {
        relativePath = normalizeLinkedRelativePath(candidate);
        break;
      } catch (error) {
        void error;
      }
    }
    relativePath ??= `page-${String(index + 1).padStart(4, "0")}${extname(page.imagePath) || ".png"}`;
    result[page.id] = makeUniqueRelativePath(relativePath, used);
  }
  return result;
}

async function materializeRecoverySources({
  chapter,
  pageRelativePaths,
  rootPath,
}: {
  chapter: ChapterSnapshot;
  pageRelativePaths: Record<string, string>;
  rootPath: string;
}): Promise<{
  sourceFingerprints: LinkedWorkspaceRecordV1["sourceFingerprints"];
  sourceRelativePaths: Record<string, string>;
}> {
  const sourceFingerprints: LinkedWorkspaceRecordV1["sourceFingerprints"] = {};
  const sourceRelativePaths: Record<string, string> = {};
  for (const page of chapter.pages) {
    const outputRelativePath = pageRelativePaths[page.id];
    if (!outputRelativePath) continue;
    const sourceRelativePath = normalizeLinkedRelativePath(
      `originals/${outputRelativePath}`,
    );
    const targetPath = resolvePathInside(rootPath, sourceRelativePath);
    const sourceFingerprint = await fingerprintFile(page.imagePath);
    const currentFingerprint = await fingerprintFileIfPresent(targetPath);
    if (currentFingerprint?.sha256 !== sourceFingerprint.sha256) {
      await copyFileAtomically(page.imagePath, targetPath);
    }
    sourceRelativePaths[page.id] = sourceRelativePath;
    sourceFingerprints[page.id] = await fingerprintFile(targetPath);
  }
  return { sourceFingerprints, sourceRelativePaths };
}

async function assertOrCreateDestinationDirectory(
  rootPath: string,
  destinationKind: LinkedWorkspaceDestinationKind,
): Promise<void> {
  if (destinationKind === "managed") {
    await mkdir(rootPath, { recursive: true });
    return;
  }
  const metadata = await stat(rootPath);
  if (!metadata.isDirectory()) {
    throw new Error("자동 저장 위치가 폴더가 아닙니다.");
  }
}

type ManagedDestinationOwnership = "available" | "owned" | "occupied";

async function inspectManagedDestination(
  rootPath: string,
  chapterId: string,
): Promise<ManagedDestinationOwnership> {
  let entries: string[];
  try {
    entries = await readdir(rootPath);
  } catch (error) {
    if (isMissingFileError(error)) return "available";
    throw error;
  }
  if (entries.length === 0) return "available";
  try {
    const mirror = JSON.parse(
      await readFile(
        resolvePathInside(rootPath, buildLinkedMirrorFileName(rootPath)),
        "utf8",
      ),
    ) as unknown;
    if (
      isRecordValue(mirror) &&
      Array.isArray(mirror.chapters) &&
      mirror.chapters.some(
        (chapter) => isRecordValue(chapter) && chapter.id === chapterId,
      )
    ) {
      return "owned";
    }
  } catch (error) {
    if (!isMissingFileError(error) && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  return "occupied";
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function makeUniqueRelativePath(preferred: string, used: Set<string>): string {
  const normalized = normalizeLinkedRelativePath(preferred);
  const key = normalized.toLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return normalized;
  }
  const extension = extname(normalized);
  const stem = normalized.slice(0, normalized.length - extension.length);
  let suffix = 2;
  while (true) {
    const candidate = `${stem} (${suffix})${extension}`;
    const candidateKey = candidate.toLowerCase();
    if (!used.has(candidateKey)) {
      used.add(candidateKey);
      return candidate;
    }
    suffix += 1;
  }
}

async function fingerprintFileIfPresent(
  filePath: string,
): Promise<Awaited<ReturnType<typeof fingerprintFile>> | null> {
  try {
    return await fingerprintFile(filePath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function safeResultPathSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  const safe = normalized || fallback;
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe)
    ? `_${safe}`
    : safe;
}

function hasStemCollision(
  record: LinkedWorkspaceRecordV1,
  pageId: string,
  sourceRelativePath: string,
): boolean {
  const normalized =
    normalizeLinkedRelativePath(sourceRelativePath).toLowerCase();
  const stem = normalized.slice(
    0,
    normalized.length - extname(normalized).length,
  );
  return Object.entries(record.pageRelativePaths).some(
    ([candidateId, path]) => {
      if (candidateId === pageId) return false;
      const candidate = normalizeLinkedRelativePath(path).toLowerCase();
      return (
        candidate.slice(0, candidate.length - extname(candidate).length) ===
        stem
      );
    },
  );
}

function artifactFromBuffer(
  rootPath: string,
  filePath: string,
  content: Buffer,
): LinkedMirrorArtifact {
  return {
    path: relativePathFromRoot(rootPath, filePath),
    bytes: content.byteLength,
    sha256: fingerprintBuffer(content),
  };
}

async function artifactFromFile(
  rootPath: string,
  filePath: string,
): Promise<LinkedMirrorArtifact> {
  const fingerprint = await fingerprintFile(filePath);
  return {
    path: relativePathFromRoot(rootPath, filePath),
    bytes: fingerprint.size,
    sha256: fingerprint.sha256,
  };
}

async function canReusePublishedArtifact({
  artifact,
  rootPath,
  sourcePath,
  targetPath,
}: {
  artifact: (LinkedMirrorArtifact & { sourcePath?: string }) | undefined;
  rootPath: string;
  sourcePath: string;
  targetPath: string;
}): Promise<boolean> {
  if (
    !artifact?.sourcePath ||
    !sameFilePath(artifact.sourcePath, sourcePath) ||
    normalizeLinkedRelativePath(artifact.path).toLowerCase() !==
      relativePathFromRoot(rootPath, targetPath).toLowerCase()
  ) {
    return false;
  }
  try {
    const metadata = await stat(targetPath);
    return metadata.isFile() && metadata.size === artifact.bytes;
  } catch (error) {
    void error;
    return false;
  }
}

async function removeReplacedArtifact(
  rootPath: string,
  previous: (LinkedMirrorArtifact & { sourcePath?: string }) | undefined,
  nextRelativePath: string | null,
  assertCurrent: () => void,
): Promise<void> {
  if (!previous) return;
  if (
    nextRelativePath &&
    normalizeLinkedRelativePath(previous.path).toLowerCase() ===
      normalizeLinkedRelativePath(nextRelativePath).toLowerCase()
  ) {
    return;
  }
  assertCurrent();
  await unlinkIfExists(resolvePathInside(rootPath, previous.path));
}

function toMirrorArtifacts(
  artifacts: LinkedWorkspaceRecordV1["artifacts"][string] | undefined,
): {
  result?: LinkedMirrorArtifact;
  inpainted?: LinkedMirrorArtifact;
  mask?: LinkedMirrorArtifact;
} {
  if (!artifacts) return {};
  return {
    ...(artifacts.result
      ? { result: stripLocalArtifact(artifacts.result) }
      : {}),
    ...(artifacts.inpainted
      ? { inpainted: stripLocalArtifact(artifacts.inpainted) }
      : {}),
    ...(artifacts.mask ? { mask: stripLocalArtifact(artifacts.mask) } : {}),
  };
}

function stripLocalArtifact(
  artifact: LinkedMirrorArtifact & { sourcePath?: string },
): LinkedMirrorArtifact {
  return {
    path: artifact.path,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
  };
}

function sameFilePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

async function inspectConnectedSource(
  record: LinkedWorkspaceRecordV1,
  pageId: string,
): Promise<
  "changed" | LinkedWorkspaceRecordV1["sourceFingerprints"][string] | null
> {
  const relativePath =
    record.sourceRelativePaths?.[pageId] ?? record.pageRelativePaths[pageId];
  const expected = record.sourceFingerprints[pageId];
  if (!relativePath || !expected) return "changed";
  const filePath = resolvePathInside(record.rootPath, relativePath);
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(filePath);
  } catch (error) {
    void error;
    return "changed";
  }
  if (!metadata.isFile()) return "changed";
  if (
    metadata.size === expected.size &&
    Math.abs(metadata.mtimeMs - expected.mtimeMs) < 1
  ) {
    return null;
  }
  const actual = await fingerprintFile(filePath);
  return actual.sha256 === expected.sha256 ? actual : "changed";
}

async function reusableSourceArtifactExists(
  rootPath: string,
  artifact: (LinkedMirrorArtifact & { sourcePath?: string }) | undefined,
  sourcePath: string,
): Promise<boolean> {
  return Boolean(
    artifact?.sourcePath &&
    sameFilePath(artifact.sourcePath, sourcePath) &&
    (await publishedArtifactExists(rootPath, artifact)),
  );
}

async function inspectPageArtifacts(
  record: LinkedWorkspaceRecordV1,
  page: MangaPage,
): Promise<{
  resultCurrent: boolean;
  inpaintedCurrent: boolean;
  maskCurrent: boolean;
}> {
  const artifacts = record.artifacts[page.id];
  const [resultCurrent, inpaintedCurrent, maskCurrent] = await Promise.all([
    publishedArtifactExists(record.rootPath, artifacts?.result),
    page.inpaintedImagePath
      ? reusableSourceArtifactExists(
          record.rootPath,
          artifacts?.inpainted,
          page.inpaintedImagePath,
        )
      : Promise.resolve(!artifacts?.inpainted),
    page.inpaintMaskPath
      ? reusableSourceArtifactExists(
          record.rootPath,
          artifacts?.mask,
          page.inpaintMaskPath,
        )
      : Promise.resolve(!artifacts?.mask),
  ]);
  return { resultCurrent, inpaintedCurrent, maskCurrent };
}

async function publishedArtifactExists(
  rootPath: string,
  artifact: LinkedMirrorArtifact | undefined,
): Promise<boolean> {
  if (!artifact) return false;
  try {
    const metadata = await stat(resolvePathInside(rootPath, artifact.path));
    return metadata.isFile() && metadata.size === artifact.bytes;
  } catch (error) {
    void error;
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    void error;
    return false;
  }
}

function normalizeRootKey(rootPath: string): string {
  const value = resolve(rootPath);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function waitForSettled(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolveTimeout) => {
      timeout = setTimeout(resolveTimeout, timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
}

function sourceArtifactFromRecord(
  record: LinkedWorkspaceRecordV1,
  pageId: string,
  sourceRelativePath: string,
): LinkedMirrorArtifact {
  const fingerprint = record.sourceFingerprints[pageId];
  if (!fingerprint) {
    throw new Error("복구 미러에 기록할 원본 이미지 해시가 없습니다.");
  }
  return {
    path: sourceRelativePath,
    bytes: fingerprint.size,
    sha256: fingerprint.sha256,
  };
}
