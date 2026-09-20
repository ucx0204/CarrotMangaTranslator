import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppActivityGate,
  AppActivityBusyError,
} from "../src/main/appActivityGate";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";
import {
  acquireJobPage,
  releaseJobPage,
} from "../src/main/jobs/jobPageOwnership";
import { libraryMutationCoordinator } from "../src/main/libraryStore/libraryMutationCoordinator";
import {
  assertLibraryActivityAccess,
  withLibraryContentEdit,
  withLibraryMutation,
  withLibraryActivityOwner,
  withLibraryArtifactCleanup,
  retainLibrarySnapshot,
} from "../src/main/library/lock";
import {
  libraryStructureResource,
  pageContentResource,
  type AppActivityResource,
} from "../src/shared/appActivityTypes";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { makePage } from "./helpers/wholePagePipelineHarness";
import { startWorkContextAnalysisWithOwnership } from "../src/main/jobs/workContextAnalysisOwnership";

let gate: AppActivityGate;
let jobs: ActiveJobStore;
beforeEach(() => {
  vi.stubEnv("MANGA_TRANSLATOR_LOG_PATH", ".tmp/activity-concurrency-test.log");
  gate = new AppActivityGate();
  jobs = new ActiveJobStore({ error: vi.fn(), info: vi.fn() }, gate);
  libraryMutationCoordinator.configureActivityGate(gate);
});
afterEach(() => {
  vi.unstubAllEnvs();
  libraryMutationCoordinator.clearRecoveryRequiredAfterStartup();
  libraryMutationCoordinator.configureActivityGate(null);
  vi.useRealTimers();
});

const model: AppActivityResource = {
  kind: "model-runtime",
  scope: "*",
  access: "write",
};
const auth: AppActivityResource = {
  kind: "codex-auth",
  scope: "*",
  access: "write",
};
function start(id: string, resources: AppActivityResource[]) {
  jobs.start({
    id,
    kind: "gemma-analysis",
    resources,
    abortController: new AbortController(),
  });
}

describe("activity ownership across concurrent work", () => {
  it("scopes context analysis without admitting another model or conflicting input/context writes", async () => {
    const repository = {
      openChapter: async () =>
        ({
          id: "chapter",
          workId: "work",
          title: "Chapter",
          sourceKind: "images",
          status: "idle",
          pageOrder: ["A"],
          pages: [makePage("A", "A.png")],
          createdAt: "2026-09-20",
          updatedAt: "2026-09-20",
        }) satisfies ChapterSnapshot,
      listLibrary: async () => ({ workOrder: [], works: [] }),
    };
    await startWorkContextAnalysisWithOwnership(
      jobs,
      "analysis",
      new AbortController(),
      { chapterId: "chapter", scope: "chapter" },
      repository,
    );
    expect(() => start("second-model", [model])).toThrow();
    expect(() =>
      start("input-write", [pageContentResource("chapter", "A")]),
    ).toThrow();
    expect(() =>
      start("context-write", [
        { kind: "work-context", scope: "work", access: "write" },
      ]),
    ).toThrow();
    start("unrelated", [pageContentResource("other", "B")]);
    await expect(
      jobs.run("analysis", () =>
        withLibraryMutation(async () => {
          assertLibraryActivityAccess([
            { kind: "work-context", scope: "work", access: "write" },
          ]);
        }),
      ),
    ).resolves.toBeUndefined();
    jobs.clearIfCurrent("analysis");
    expect(jobs.all.map((job) => job.id)).toEqual(["unrelated"]);
    jobs.clearIfCurrent("unrelated");
  });
  it("allows a queued job save without granting its page to an unrelated queued editor", async () => {
    const resource = pageContentResource("chapter", "A");
    start("sfx", [resource]);
    let release!: () => void;
    const first = withLibraryActivityOwner("manual", () =>
      withLibraryMutation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const save = () =>
      withLibraryMutation(async () => {
        assertLibraryActivityAccess([resource]);
        await Promise.resolve();
        assertLibraryActivityAccess([resource]);
        return "saved";
      });
    const ownSave = withLibraryActivityOwner("sfx", save);
    const outsiderSave = save();
    const result = Promise.allSettled([ownSave, outsiderSave]);
    release();
    await first;
    const [own, outsider] = await result;
    expect(own).toEqual({ status: "fulfilled", value: "saved" });
    expect(outsider.status).toBe("rejected");
    if (outsider.status === "rejected")
      expect(outsider.reason).toBeInstanceOf(AppActivityBusyError);
    expect(jobs.get("sfx")).not.toBeNull();
    expect(libraryMutationCoordinator.getActiveCountForTests()).toBe(0);
  });

  it("rejects an export snapshot conflict without leaving a pending library operation", () => {
    start("writer", [
      { kind: "output-path", scope: "C:/out/chapter.zip", access: "write" },
    ]);
    expect(() =>
      retainLibrarySnapshot(
        [{ kind: "output-path", scope: "C:/out/chapter.zip", access: "write" }],
        [],
      ),
    ).toThrow(AppActivityBusyError);
    expect(libraryMutationCoordinator.getActiveCountForTests()).toBe(0);
    expect(jobs.all.map((job) => job.id)).toEqual(["writer"]);
  });

  it("cancels an unspecified-resource waiter without spinning or stealing a live lease", async () => {
    start("writer", [model]);
    const controller = new AbortController();
    const waiting = gate.acquireWhenAvailable(
      {
        id: "legacy",
        category: "operation",
        kind: "legacy",
        mutatesLibrary: false,
        blocksQuit: true,
      },
      controller.signal,
    );
    const failure = expect(waiting).rejects.toThrow("cancelled wait");
    await Promise.resolve();
    expect(gate.activities).toHaveLength(1);
    controller.abort(new Error("cancelled wait"));
    await failure;
    expect(jobs.get("writer")).not.toBeNull();
  });

  it("keeps ownership if an observer fails and refuses conflicts when updating a lease", () => {
    const unsubscribe = gate.subscribe(() => {
      throw new Error("observer failed");
    });
    const first = gate.acquire({
      id: "first",
      category: "operation",
      kind: "first",
      mutatesLibrary: false,
      blocksQuit: true,
      resources: [],
    });
    unsubscribe();
    start("writer", [model]);
    expect(() => first.updateResources([model])).toThrow(AppActivityBusyError);
    expect(first.descriptor.resources).toEqual([]);
    first.release();
    expect(() => first.updateResources([])).toThrow("already released");
    expect(jobs.get("writer")).not.toBeNull();
  });

  it("drains artifact cleanup after shutdown while user edits and recovery writes remain blocked", async () => {
    libraryMutationCoordinator.closeToNewMutations();
    expect(() => withLibraryMutation(async () => undefined)).toThrow("종료 중");
    const cleanup = vi.fn(async () => {
      expect(libraryMutationCoordinator.getActiveCountForTests()).toBe(1);
      return "released";
    });
    expect(await withLibraryArtifactCleanup(cleanup)).toBe("released");
    await libraryMutationCoordinator.waitForIdle();
    libraryMutationCoordinator.markRecoveryRequired(
      new Error("unsettled transaction"),
    );
    expect(() => withLibraryArtifactCleanup(cleanup)).toThrow("복구");
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it("waits to publish an import without holding up another page's library save", async () => {
    start("translation", [
      model,
      libraryStructureResource("work", "work", "read"),
    ]);
    const published = vi.fn(async () => "imported");
    const pending = withLibraryContentEdit(
      [libraryStructureResource("work", "work")],
      () => withLibraryMutation(published),
      new AbortController().signal,
    );
    await withLibraryMutation(async () => "unrelated text saved");
    expect(published).not.toHaveBeenCalled();
    jobs.clearIfCurrent("translation");
    await expect(pending).resolves.toBe("imported");
    expect(gate.activities).toEqual([]);
  });

  it("cancels a waiting publication and releases pending work on intake shutdown", async () => {
    start("translation", [model]);
    const pending = gate.acquireWhenAvailable(
      {
        id: "test",
        kind: "test",
        category: "operation",
        blocksQuit: true,
        mutatesLibrary: false,
        resources: [model],
      },
      new AbortController().signal,
    );
    const rejected = expect(pending).rejects.toThrow(/intake is closed/);
    gate.closeToNewActivities();
    await rejected;
    expect(jobs.get("translation")).not.toBeNull();
  });
  it("allows B edits, import and unrelated auth while A owns local inference; rejects A even at the storage boundary", async () => {
    start("translation", [model, pageContentResource("chapter", "A")]);
    const operation = new AppOperationRegistry(gate).begin({
      id: "import",
      kind: "library-import",
      mutatesLibrary: true,
      resources: [],
    });
    const login = gate.acquire({
      id: "login",
      category: "operation",
      kind: "codex-auth",
      mutatesLibrary: false,
      blocksQuit: true,
      resources: [auth],
    });
    await expect(
      withLibraryContentEdit([pageContentResource("chapter", "B")], () =>
        withLibraryMutation(async () => {
          assertLibraryActivityAccess([pageContentResource("chapter", "B")]);
          return "B saved";
        }),
      ),
    ).resolves.toBe("B saved");
    await expect(
      withLibraryMutation(async () =>
        assertLibraryActivityAccess([pageContentResource("chapter", "A")]),
      ),
    ).rejects.toThrow(AppActivityBusyError);
    expect(() => start("model-test", [model])).toThrow(/모델/);
    operation.finish();
    login.release();
    expect(jobs.get("translation")).not.toBeNull();
  });

  it("separates queued reservations from writes and reads latest data after an image edit drains", async () => {
    const page = makePage("B", "B.png");
    let current: ChapterSnapshot = {
      id: "chapter",
      workId: "work",
      title: "chapter",
      sourceKind: "images",
      status: "idle",
      pageOrder: [page.id],
      pages: [page],
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    };
    start("translation", [
      model,
      libraryStructureResource("chapter", "chapter", "read"),
    ]);
    jobs.pageHandoffs.reserve("translation", "chapter", [page.id]);
    expect(() =>
      gate.assertAvailable([pageContentResource("chapter", "B")]),
    ).not.toThrow();
    expect(() =>
      gate.assertAvailable([libraryStructureResource("chapter", "chapter")]),
    ).toThrow();
    let finishPaint!: () => void;
    const painting = withLibraryContentEdit(
      [pageContentResource("chapter", "B")],
      async () => {
        await new Promise<void>((resolve) => {
          finishPaint = resolve;
        });
        current = {
          ...current,
          pages: [{ ...page, inpaintedImagePath: "latest-paint.png" }],
        };
      },
    );
    const read = vi.fn(async () => current);
    const acquisition = acquireJobPage(
      jobs,
      "translation",
      "chapter",
      "B",
      read,
    );
    const requestId = requirePresent(jobs.pageHandoffs.activities[0].requestId);
    jobs.pageHandoffs.respond({ requestId });
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    finishPaint();
    await painting;
    await expect(acquisition).resolves.toMatchObject({
      inpaintedImagePath: "latest-paint.png",
    });
    expect(jobs.pageHandoffs.activities[0].phase).toBe("processing");
    expect(() =>
      gate.assertAvailable([pageContentResource("chapter", "B")]),
    ).toThrow();
    releaseJobPage(jobs, "translation", "chapter", "B");
    expect(() =>
      gate.assertAvailable([pageContentResource("chapter", "B")]),
    ).not.toThrow();
  });

  it("requires an explicit retry after save failure and ignores an old acknowledgement", async () => {
    start("translation", [model]);
    const signal = requirePresent(jobs.get("translation")).abortController
      .signal;
    let ready = false;
    const handoff = jobs.pageHandoffs
      .request("translation", "chapter", "A", signal)
      .then(() => {
        ready = true;
      });
    const first = requirePresent(jobs.pageHandoffs.activities[0].requestId);
    jobs.pageHandoffs.respond({ requestId: first, error: "disk full" });
    await vi.waitFor(() =>
      expect(jobs.pageHandoffs.activities[0].phase).toBe("waiting"),
    );
    jobs.pageHandoffs.retry(first);
    await vi.waitFor(() =>
      expect(jobs.pageHandoffs.activities[0].requestId).not.toBe(first),
    );
    expect(jobs.pageHandoffs.respond({ requestId: first })).toBe(false);
    expect(ready).toBe(false);
    jobs.pageHandoffs.respond({
      requestId: requirePresent(jobs.pageHandoffs.activities[0].requestId),
    });
    await handoff;
    expect(ready).toBe(true);
  });

  it("does not let one job or operation cancellation release another owner's resources", async () => {
    start("translation", [model]);
    start("remote", [{ ...auth, access: "read" }]);
    expect(() => gate.assertAvailable([auth])).toThrow(/ChatGPT/);
    jobs.clearIfCurrent("translation");
    jobs.clearIfCurrent("translation");
    expect(jobs.all.map((job) => job.id)).toEqual(["remote"]);
    const registry = new AppOperationRegistry(gate);
    const first = registry.begin({
      id: "export-1",
      kind: "work-share-export",
      mutatesLibrary: false,
      resources: [],
      presentation: { cancellable: true },
    });
    const second = registry.begin({
      id: "export-2",
      kind: "work-share-export",
      mutatesLibrary: false,
      resources: [],
      presentation: { cancellable: true },
    });
    registry.requestCancel(first.id);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    first.finish("cancelled");
    expect(registry.activities.map((event) => event.id)).toEqual(["export-2"]);
    second.finish();
    jobs.clearIfCurrent("remote");
    expect(gate.activities).toEqual([]);
  });

  it("protects a chapter from deletion for the whole duration of a manual image edit", async () => {
    await withLibraryContentEdit(
      [pageContentResource("chapter", "A")],
      async () => {
        expect(() =>
          gate.assertAvailable([
            libraryStructureResource("chapter", "chapter"),
          ]),
        ).toThrow();
        expect(() =>
          gate.assertAvailable([pageContentResource("chapter", "**")]),
        ).toThrow();
        expect(() =>
          gate.assertAvailable([pageContentResource("other", "A")]),
        ).not.toThrow();
      },
    );
    expect(gate.activities).toEqual([]);
  });
});

function requirePresent<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Expected an active handoff fixture.");
  return value;
}
