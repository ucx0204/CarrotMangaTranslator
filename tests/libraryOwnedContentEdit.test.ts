import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertLibraryActivityAccess,
  withLibraryActivityOwner,
  withLibraryContentEdit,
  withLibraryOwnedContentEdit,
} from "../src/main/library/lock";
import { libraryMutationCoordinator } from "../src/main/libraryStore/libraryMutationCoordinator";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import {
  reserveJobChapter,
  acquireJobPage,
} from "../src/main/jobs/jobPageOwnership";
import { AppActivityBusyError } from "../src/main/appActivityGate";
import { pageContentResource } from "../src/shared/appActivityTypes";
import { editingChapter } from "./mcpEditing.fixture";

vi.mock("electron", () => ({ app: { isPackaged: false }, nativeImage: {} }));
const active: ActiveJobStore[] = [];
const subscriptions: (() => void)[] = [];
afterEach(() => {
  for (const detach of subscriptions.splice(0)) detach();
  for (const jobs of active.splice(0))
    for (const job of jobs.all) jobs.clearIfCurrent(job.id);
  libraryMutationCoordinator.configureActivityGate(null);
  libraryMutationCoordinator.clearRecoveryRequiredAfterStartup();
});
function setup() {
  const jobs = new ActiveJobStore({ error: vi.fn(), info: vi.fn() });
  active.push(jobs);
  libraryMutationCoordinator.configureActivityGate(jobs.gate);
  subscriptions.push(
    jobs.pageHandoffs.subscribe(() => {
      for (const page of jobs.pageHandoffs.activities) {
        if (page.phase === "finishing-edits" && page.requestId) {
          const requestId = page.requestId;
          queueMicrotask(() => jobs.pageHandoffs.respond({ requestId }));
        }
      }
    }),
  );
  return jobs;
}

describe("trusted nested native content ownership", () => {
  it("enters with pages acquired by the same actual app job and releases all nested leases", async () => {
    const jobs = setup();
    const chapter = editingChapter();
    const page = chapter.pages[0];
    if (!page) throw new Error("fixture page missing");
    const resource = pageContentResource(chapter.id, page.id);
    jobs.start({
      id: "owned",
      kind: "page-export",
      resources: [],
      abortController: new AbortController(),
    });
    await jobs.run("owned", async () => {
      reserveJobChapter(jobs, "owned", chapter, [page.id]);
      await acquireJobPage(
        jobs,
        "owned",
        chapter.id,
        page.id,
        async () => chapter,
      );
      await withLibraryOwnedContentEdit([resource], async () => {
        await withLibraryOwnedContentEdit([resource], async () => {
          assertLibraryActivityAccess([resource]);
          expect(libraryMutationCoordinator.getActiveCountForTests()).toBe(2);
        });
        expect(libraryMutationCoordinator.getActiveCountForTests()).toBe(1);
      });
      expect(libraryMutationCoordinator.getActiveCountForTests()).toBe(0);
    });
    jobs.clearIfCurrent("owned");
    expect(jobs.gate.current).toBeNull();
    expect(jobs.all).toEqual([]);
  });

  it("rejects an unrelated owner and preserves the original content-edit behavior", async () => {
    const jobs = setup();
    const resource = pageContentResource("chapter", "page");
    jobs.start({
      id: "owner",
      kind: "page-export",
      resources: [resource],
      abortController: new AbortController(),
    });
    const execute = vi.fn(async () => undefined);
    await expect(
      withLibraryActivityOwner("other", () =>
        withLibraryOwnedContentEdit([resource], execute),
      ),
    ).rejects.toBeInstanceOf(AppActivityBusyError);
    await expect(
      jobs.run("owner", () => withLibraryContentEdit([resource], execute)),
    ).rejects.toBeInstanceOf(AppActivityBusyError);
    expect(execute).not.toHaveBeenCalled();
    expect(libraryMutationCoordinator.getActiveCountForTests()).toBe(0);
    await jobs.run("owner", () =>
      withLibraryOwnedContentEdit([resource], execute),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("creates an ordinary standalone owner and cleans it after a failure", async () => {
    const jobs = setup();
    const resource = pageContentResource("chapter", "page");
    const failure = new Error("native write failed");
    await expect(
      withLibraryOwnedContentEdit([resource], async () => {
        assertLibraryActivityAccess([resource]);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(jobs.gate.current).toBeNull();
    expect(libraryMutationCoordinator.getActiveCountForTests()).toBe(0);
  });

  it("releases acquired activity when mutation intake was suspended while waiting", async () => {
    const jobs = setup();
    const resource = pageContentResource("chapter", "page");
    jobs.start({
      id: "blocker",
      kind: "page-export",
      resources: [resource],
      abortController: new AbortController(),
    });
    const execute = vi.fn(async () => undefined);
    const waiting = withLibraryOwnedContentEdit(
      [resource],
      execute,
      new AbortController().signal,
    );
    const rejected = expect(waiting).rejects.toThrow(/일시적으로 중지/);
    const suspension = libraryMutationCoordinator.suspendNewMutations();
    try {
      jobs.clearIfCurrent("blocker");
      await rejected;
      expect(execute).not.toHaveBeenCalled();
      expect(jobs.gate.activities).toEqual([]);
      expect(libraryMutationCoordinator.getActiveCountForTests()).toBe(0);
    } finally {
      suspension.release();
    }
  });

  it.each(["closing", "suspended", "gate-closed", "cancelled"] as const)(
    "cannot bypass %s intake",
    async (mode) => {
      const jobs = setup();
      const controller = new AbortController();
      const suspension =
        mode === "suspended"
          ? libraryMutationCoordinator.suspendNewMutations()
          : undefined;
      if (mode === "closing") libraryMutationCoordinator.closeToNewMutations();
      if (mode === "gate-closed") jobs.gate.closeToNewActivities();
      if (mode === "cancelled") controller.abort();
      const execute = vi.fn(async () => undefined);
      try {
        await expect(
          withLibraryActivityOwner("trusted-owner", () =>
            withLibraryOwnedContentEdit(
              [pageContentResource("chapter", "page")],
              execute,
              controller.signal,
            ),
          ),
        ).rejects.toThrow();
        expect(execute).not.toHaveBeenCalled();
        expect(libraryMutationCoordinator.getActiveCountForTests()).toBe(0);
        expect(jobs.gate.activities).toEqual([]);
      } finally {
        suspension?.release();
      }
    },
  );
});
