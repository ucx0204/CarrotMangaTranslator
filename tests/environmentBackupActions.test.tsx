// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useEnvironmentBackup } from "../src/renderer/src/components/settingsModal/useEnvironmentBackup";
import { pendingPageEdits } from "../src/renderer/src/lib/pageEditBarrier";
import { usePageEditHandoff } from "../src/renderer/src/hooks/usePageEditHandoff";
import type { AppOperationActivityEvent } from "../src/shared/appOperationTypes";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
const preview = {
  id: "11111111-1111-4111-8111-111111111111",
  createdAt: "2026-09-24",
  appVersion: "2.8.0",
  works: 1,
  pages: 2,
  bytes: 3,
  recoveryPath: "old",
  connections: [],
};

describe("backup settings actions", () => {
  it("waits for editor flushes and saves each open page before taking the snapshot", async () => {
    const order: string[] = [];
    const release = pendingPageEdits.registerFlusher(async (_chapter, page) => {
      order.push(`editor:${page}`);
    });
    const save = vi.fn(async (_chapter: string, page: string) => {
      order.push(`save:${page}`);
    });
    renderHook(() =>
      usePageEditHandoff(null, save, {
        chapterId: "chapter",
        pageIds: ["a", "b"],
      }),
    );
    try {
      await act(() => pendingPageEdits.flushEnvironment());
      expect(order).toEqual(["editor:a", "save:a", "editor:b", "save:b"]);
      expect(save).toHaveBeenCalledTimes(2);
    } finally {
      release();
    }
  });
  it("flushes pending page edits before exporting saved UI preferences", async () => {
    const order: string[] = [];
    const release = pendingPageEdits.registerEnvironmentFlusher(async () => {
      order.push("flush");
    });
    const exportBackup = vi.fn(async () => {
      order.push("export");
      return "backup.zip";
    });
    window.mangaApi = createTestMangaGatewayStub({
      exportEnvironmentBackup: exportBackup,
    });
    window.localStorage.setItem("library-sort", "title");
    const { result } = renderHook(useEnvironmentBackup);
    try {
      await waitFor(() => expect(result.current.status).not.toBeNull());
      await act(() => result.current.exportBackup());
      expect(order).toEqual(["flush", "export"]);
      expect(exportBackup).toHaveBeenCalledWith({ "library-sort": "title" });
      expect(result.current.savedPath).toBe("backup.zip");
    } finally {
      release();
    }
  });
  it("shows a validated preview, applies only on confirmation, and discards it on dismissal", async () => {
    const restore = vi.fn(async () => null);
    const discard = vi.fn(async () => null);
    window.mangaApi = createTestMangaGatewayStub({
      previewEnvironmentBackup: async () => preview,
      restoreEnvironmentBackup: restore,
      discardEnvironmentBackup: discard,
    });
    const { result } = renderHook(useEnvironmentBackup);
    await waitFor(() => expect(result.current.status).not.toBeNull());
    await act(() => result.current.inspectBackup());
    expect(result.current.preview).toEqual(preview);
    expect(restore).not.toHaveBeenCalled();
    act(() => result.current.dismiss());
    expect(discard).toHaveBeenCalledExactlyOnceWith(preview.id);
    expect(result.current.preview).toBeNull();
    await act(() => result.current.inspectBackup());
    await act(() => result.current.apply());
    expect(restore).toHaveBeenCalledExactlyOnceWith(preview.id, {});
    expect(result.current.preview).toBeNull();
    expect(discard).toHaveBeenCalledTimes(1);
  });
  it("can resume confirmation after leaving settings while the ZIP is being checked", async () => {
    let complete!: (value: typeof preview) => void;
    const checking = new Promise<typeof preview>((resolve) => {
      complete = resolve;
    });
    const inspectZip = vi.fn(() => checking);
    const restore = vi.fn(async () => null);
    const discard = vi.fn(async () => null);
    let ready: typeof preview | null = null;
    const running: AppOperationActivityEvent = {
      id: "check",
      kind: "environment-backup-preview",
      status: "running",
      cancellable: true,
      mutatesLibrary: true,
      startedAt: 1,
      updatedAt: 1,
    };
    const listeners = new Set<(event: AppOperationActivityEvent) => void>();
    window.mangaApi = createTestMangaGatewayStub({
      previewEnvironmentBackup: inspectZip,
      onAppOperationActivity: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      getActiveAppOperations: async () =>
        !ready && inspectZip.mock.calls.length ? [running] : [],
      getEnvironmentBackupStatus: async () => ({
        summary: { works: 0, pages: 0, bytes: 0 },
        restored: null,
        recoveries: [],
        pendingPreview: ready,
      }),
      restoreEnvironmentBackup: restore,
      discardEnvironmentBackup: discard,
    });
    const first = renderHook(useEnvironmentBackup);
    let inspect!: Promise<void>;
    act(() => {
      inspect = first.result.current.inspectBackup();
    });
    await waitFor(() => expect(inspectZip).toHaveBeenCalledOnce());
    first.unmount();
    const second = renderHook(useEnvironmentBackup);
    await waitFor(() => expect(second.result.current.busy).toBe(true));
    expect(second.result.current.preview).toBeNull();
    await act(async () => {
      ready = preview;
      complete(preview);
      await inspect;
      for (const listener of listeners)
        listener({ ...running, status: "completed", cancellable: false });
    });
    await waitFor(() => expect(second.result.current.preview).toEqual(preview));
    second.unmount();
    expect(discard).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    const third = renderHook(useEnvironmentBackup);
    await waitFor(() => expect(third.result.current.preview).toEqual(preview));
    await act(() => third.result.current.apply());
    expect(restore).toHaveBeenCalledExactlyOnceWith(preview.id, {});
  });
  it("surfaces failure, clears busy state and allows a later recovery request", async () => {
    const recover = vi.fn(async () => null);
    window.mangaApi = createTestMangaGatewayStub({
      exportEnvironmentBackup: async () => {
        throw new Error("disk full");
      },
      recoverEnvironmentBackup: recover,
    });
    const { result } = renderHook(useEnvironmentBackup);
    await waitFor(() => expect(result.current.status).not.toBeNull());
    await act(() => result.current.exportBackup());
    expect(result.current.error).toBe("disk full");
    expect(result.current.busy).toBe(false);
    act(() => result.current.chooseRecovery("recovery"));
    await act(() => result.current.apply());
    expect(recover).toHaveBeenCalledWith("recovery", {});
    expect(result.current.error).toBe("");
  });
});
