/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCodexDelegation } from "../src/renderer/src/hooks/useCodexDelegation";
import { codexConnection } from "../src/renderer/src/api/codexConnection";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { getToasts, dismissToast } from "../src/renderer/src/lib/toastStore";
import type { AppSettings } from "../src/shared/settingsTypes";
import type { MangaApi } from "../src/shared/mangaApi";
import type { CodexAccountSnapshot } from "../src/shared/codexAccountTypes";

const account: CodexAccountSnapshot = {
  authenticated: true,
  accountKind: "chatgpt",
  email: null,
  planType: null,
  requiresOpenaiAuth: true,
  appServerVersion: "test",
  models: [
    {
      id: "gpt-6-astra",
      displayName: "Astra",
      supportedReasoningEfforts: ["low"],
      defaultReasoningEffort: "low",
      isDefault: true,
    },
  ],
};
let listener: Parameters<MangaApi["onJobEvent"]>[0] | undefined;
const cancel = vi.fn(async () => undefined);
const settings = {
  modelProvider: "openai-codex",
  codex: { model: "gpt-6-astra", reasoningEffort: "low", delegateAll: true },
} as AppSettings;

beforeEach(async () => {
  cancel.mockClear();
  window.mangaApi = createTestMangaGatewayStub({
    getCodexAccount: async () => account,
    onJobEvent: (callback) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    cancelJob: cancel,
  });
  codexConnection.publish(account);
  await codexConnection.refresh();
});
afterEach(() => {
  cleanup();
  for (const toast of getToasts()) dismissToast(toast.id);
});
const setConnected = async (authenticated: boolean) => {
  await act(async () => codexConnection.publish({ ...account, authenticated }));
};

describe("Codex delegation connection changes", () => {
  it("preserves the requested mode offline and enables it again on reconnect", async () => {
    const { result, rerender } = renderHook(
      ({ current }) => useCodexDelegation(current),
      { initialProps: { current: settings } },
    );
    await act(async () => {
      await codexConnection.refresh();
    });
    expect(result.current).toBe(true);
    await setConnected(false);
    expect(result.current).toBe(false);
    expect(settings.codex.delegateAll).toBe(true);
    await setConnected(true);
    expect(result.current).toBe(true);
    rerender({
      current: {
        ...settings,
        codex: { ...settings.codex, delegateAll: false },
      },
    });
    rerender({ current: settings });
    expect(result.current).toBe(true);
  });
  it("cancels the tracked Codex job on disconnect without restarting it", async () => {
    renderHook(() => useCodexDelegation(settings));
    await act(async () => {
      await codexConnection.refresh();
    });
    act(() =>
      listener?.({
        kind: "gemma-analysis",
        status: "running",
        id: "job-1",
      } as Parameters<NonNullable<typeof listener>>[0]),
    );
    await setConnected(false);
    expect(cancel).toHaveBeenCalledExactlyOnceWith({
      reason: "codex-disconnected",
      jobId: "job-1",
    });
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0].variant).toBe("error");
    await setConnected(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

it.each(["sound-effect-translation", "inpainting"] as const)(
  "stops tracking a partially completed %s job before disconnect",
  async (kind) => {
    renderHook(() => useCodexDelegation(settings));
    await act(async () => {
      await codexConnection.refresh();
    });
    act(() => {
      listener?.({ kind, status: "running", id: "partial-job" } as Parameters<
        NonNullable<typeof listener>
      >[0]);
      listener?.({ kind, status: "partial", id: "partial-job" } as Parameters<
        NonNullable<typeof listener>
      >[0]);
    });
    await setConnected(false);
    expect(cancel).not.toHaveBeenCalled();
  },
);
it("marks the connection unavailable when refreshing a failed job also fails", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const { result } = renderHook(() => useCodexDelegation(settings));
  await act(async () => {
    await codexConnection.refresh();
  });
  window.mangaApi = createTestMangaGatewayStub({
    getCodexAccount: async () => {
      throw new Error("bridge unavailable");
    },
  });
  await act(async () => {
    listener?.({
      kind: "inpainting",
      status: "failed",
      id: "failed-job",
    } as Parameters<NonNullable<typeof listener>>[0]);
  });
  expect(codexConnection.getSnapshot()).toBeNull();
  expect(result.current).toBe(false);
  expect(settings.codex.delegateAll).toBe(true);
  logged.mockRestore();
});
it("does not subscribe to Codex jobs with no active Codex settings", () => {
  const { result } = renderHook(() => useCodexDelegation(null));
  expect(result.current).toBe(false);
  expect(listener).toBeUndefined();
});

it("records that the persisted connection has been checked", () => {
  expect(codexConnection.isChecked()).toBe(true);
});
