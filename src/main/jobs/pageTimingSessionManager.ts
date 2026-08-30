import type { MangaPage } from "../../shared/libraryTypes";
import {
  normalizePageProcessingTiming,
  sumPageProcessingTimingStages,
  type FinishPageTimingSessionRequest,
  type FinishPageTimingSessionResult,
  type PageProcessingTimingStage,
  type PageTimingSessionRef,
} from "../../shared/pageProcessingTiming";
import { updatePageProcessingTimings } from "../library";
import {
  logInpaintingRuntimeError,
  logInpaintingRuntimeWarn,
} from "../inpainting/inpaintingRuntimeLogger";
import {
  createPageProcessingTimingCollector,
  type PageProcessingTimingCollector,
  type PageTimingCheckpoint,
} from "../pipeline/pageProcessingTiming";
import type { JobEventWindow } from "./jobEventDispatchQueue";
import { emitPageTimingUpdated } from "./pageTimingEvents";

type PageTimingSessionKind = "translation" | "inpainting";

export type OpenPageTimingSessionOptions = Readonly<{
  chapterId: string;
  getMainWindow: () => JobEventWindow | null;
  jobId: string;
  kind: PageTimingSessionKind;
  pages: readonly MangaPage[];
  session: PageTimingSessionRef;
}>;

export type PageTimingSessionManagerDependencies = Readonly<{
  nowEpochMs: () => number;
  persist: typeof updatePageProcessingTimings;
  emitUpdated: typeof emitPageTimingUpdated;
  logError: (message: string, detail?: unknown) => void;
  logWarn: (message: string, detail?: unknown) => void;
}>;

type ManagedSession = {
  baselinePreparingByPageId: Map<string, number>;
  baselineTotalMs: number;
  chapterId: string;
  collector: PageProcessingTimingCollector;
  forcedElapsedMs?: number;
  getMainWindow: () => JobEventWindow | null;
  lastPersistenceSucceeded: boolean;
  previousSessionIdByPageId: Map<string, string | undefined>;
  session: PageTimingSessionRef;
  startedPageIds: Set<string>;
};

type InitialSessionState = Pick<
  ManagedSession,
  "baselinePreparingByPageId" | "baselineTotalMs" | "previousSessionIdByPageId"
> & {
  initialStagesByPageId: Map<
    string,
    Partial<Record<PageProcessingTimingStage, number>>
  >;
};

const productionDependencies: PageTimingSessionManagerDependencies = {
  nowEpochMs: Date.now,
  persist: updatePageProcessingTimings,
  emitUpdated: emitPageTimingUpdated,
  logError: logInpaintingRuntimeError,
  logWarn: logInpaintingRuntimeWarn,
};

export class PageTimingSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();

  public constructor(
    private readonly dependencies: PageTimingSessionManagerDependencies,
  ) {}

  public async open(
    options: OpenPageTimingSessionOptions,
  ): Promise<PageProcessingTimingCollector> {
    const existing = this.sessions.get(options.session.id);
    if (existing) {
      this.continueSession(existing, options);
      return existing.collector;
    }
    const entry = this.createSession(options);
    this.sessions.set(options.session.id, entry);
    await entry.collector.checkpoint();
    return entry.collector;
  }

  public async checkpoint(sessionId: string): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    await entry.collector.checkpoint();
    return entry.lastPersistenceSucceeded;
  }

  public async finish(
    request: FinishPageTimingSessionRequest,
  ): Promise<FinishPageTimingSessionResult> {
    const entry = this.sessions.get(request.sessionId);
    if (!entry || entry.chapterId !== request.chapterId) {
      return { updated: false };
    }
    entry.forcedElapsedMs = normalizeElapsedMs(request.elapsedMs);
    entry.collector.setState(request.state);
    try {
      await entry.collector.checkpoint();
      if (!entry.lastPersistenceSucceeded) {
        await entry.collector.checkpoint();
      }
      return { updated: entry.lastPersistenceSucceeded };
    } finally {
      this.sessions.delete(request.sessionId);
    }
  }

  private continueSession(
    entry: ManagedSession,
    options: OpenPageTimingSessionOptions,
  ): void {
    if (entry.chapterId !== options.chapterId) {
      throw new Error("A page timing session cannot span multiple chapters.");
    }
    entry.getMainWindow = options.getMainWindow;
    if (options.kind === "translation") {
      entry.collector.setTranslationJobId(options.jobId);
    } else {
      entry.collector.setInpaintingJobId(options.jobId);
    }
  }

  private createSession(options: OpenPageTimingSessionOptions): ManagedSession {
    const initial = buildInitialSessionState(options.pages, options.kind);
    const holder: { entry?: ManagedSession } = {};
    const collector = createPageProcessingTimingCollector(
      options.jobId,
      options.pages.map((page) => page.id),
      {
        sessionId: options.session.id,
        managed: true,
        state: "running",
        initialStagesByPageId: initial.initialStagesByPageId,
        ...(options.kind === "translation"
          ? { translationJobId: options.jobId }
          : { inpaintingJobId: options.jobId }),
        onBeforeCheckpoint: () => this.reconcile(requireEntry(holder)),
        onCheckpoint: (updates) =>
          this.persistCheckpoint(requireEntry(holder), updates),
      },
    );
    const entry: ManagedSession = {
      ...initial,
      chapterId: options.chapterId,
      collector,
      getMainWindow: options.getMainWindow,
      lastPersistenceSucceeded: false,
      session: options.session,
      startedPageIds: new Set(),
    };
    holder.entry = entry;
    return entry;
  }

  private reconcile(entry: ManagedSession): void {
    const elapsedMs = normalizeElapsedMs(
      entry.forcedElapsedMs ??
        this.dependencies.nowEpochMs() - entry.session.startedAtEpochMs,
    );
    const desiredTotalMs = entry.baselineTotalMs + elapsedMs;
    const differenceMs =
      desiredTotalMs - entry.collector.getTotalMilliseconds();
    if (differenceMs > 0) {
      entry.collector.addShared("preparing", differenceMs);
    } else if (differenceMs < 0) {
      removeSessionPreparingTime(entry, -differenceMs);
    }
  }

  private async persistCheckpoint(
    entry: ManagedSession,
    updates: readonly PageTimingCheckpoint[],
  ): Promise<void> {
    try {
      const changed = await this.dependencies.persist(
        entry.chapterId,
        updates.map((update) => buildPersistenceUpdate(entry, update)),
      );
      for (const pageId of changed) entry.startedPageIds.add(pageId);
      entry.lastPersistenceSucceeded = changed.size === updates.length;
      this.reportPersistenceResult(entry, updates.length, changed);
    } catch (error) {
      entry.lastPersistenceSucceeded = false;
      this.dependencies.logError("Failed to persist page timing checkpoint", {
        chapterId: entry.chapterId,
        sessionId: entry.session.id,
        error,
      });
    }
  }

  private reportPersistenceResult(
    entry: ManagedSession,
    requestedCount: number,
    changed: ReadonlySet<string>,
  ): void {
    if (changed.size > 0) {
      this.dependencies.emitUpdated(entry.getMainWindow(), {
        chapterId: entry.chapterId,
        pageIds: [...changed],
      });
    }
    if (!entry.lastPersistenceSucceeded) {
      this.dependencies.logWarn("Some page timing checkpoints were rejected", {
        chapterId: entry.chapterId,
        sessionId: entry.session.id,
        requested: requestedCount,
        updated: changed.size,
      });
    }
  }
}

function buildInitialSessionState(
  pages: readonly MangaPage[],
  kind: PageTimingSessionKind,
): InitialSessionState {
  const initialStagesByPageId = new Map<
    string,
    Partial<Record<PageProcessingTimingStage, number>>
  >();
  const baselinePreparingByPageId = new Map<string, number>();
  const previousSessionIdByPageId = new Map<string, string | undefined>();
  for (const page of pages) {
    const previous = normalizePageProcessingTiming(page.processingTiming);
    const reset = kind === "translation" && previous.state === "completed";
    const initialStages = reset ? {} : previous.stages;
    initialStagesByPageId.set(page.id, initialStages);
    baselinePreparingByPageId.set(page.id, initialStages.preparing ?? 0);
    previousSessionIdByPageId.set(page.id, previous.sessionId);
  }
  return {
    initialStagesByPageId,
    baselinePreparingByPageId,
    baselineTotalMs: [...initialStagesByPageId.values()].reduce(
      (total, stages) => total + sumPageProcessingTimingStages(stages),
      0,
    ),
    previousSessionIdByPageId,
  };
}

function buildPersistenceUpdate(
  entry: ManagedSession,
  { pageId, timing }: PageTimingCheckpoint,
) {
  if (entry.startedPageIds.has(pageId)) return { pageId, timing };
  const replacesSessionId = entry.previousSessionIdByPageId.get(pageId);
  return {
    pageId,
    timing,
    startSession: true,
    ...(replacesSessionId ? { replacesSessionId } : {}),
  };
}

function removeSessionPreparingTime(
  entry: ManagedSession,
  requestedRemovalMs: number,
): void {
  let remaining = normalizeElapsedMs(requestedRemovalMs);
  for (const pageId of [...entry.collector.getPageIds()].reverse()) {
    if (remaining <= 0) break;
    const current = entry.collector.getStages(pageId).preparing ?? 0;
    const baseline = entry.baselinePreparingByPageId.get(pageId) ?? 0;
    const removal = Math.min(Math.max(0, current - baseline), remaining);
    entry.collector.setStage(pageId, "preparing", current - removal);
    remaining -= removal;
  }
}

function requireEntry(holder: { entry?: ManagedSession }): ManagedSession {
  if (!holder.entry) throw new Error("Page timing session is not initialized.");
  return holder.entry;
}

function normalizeElapsedMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function createPageTimingSessionManager(
  dependencies: PageTimingSessionManagerDependencies = productionDependencies,
): PageTimingSessionManager {
  return new PageTimingSessionManager(dependencies);
}

export const pageTimingSessionManager = createPageTimingSessionManager();
