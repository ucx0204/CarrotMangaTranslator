/** @vitest-environment jsdom */
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { McpDesktopStatus } from "../src/shared/mcpDesktopTypes";
import type { McpPageChangedEvent } from "../src/shared/mcpEditingTypes";
import { McpSettingsView } from "../src/renderer/src/components/settingsModal/McpSettingsPanel";
import { useMcpEditorSync } from "../src/renderer/src/hooks/useMcpEditorSync";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { editingChapter } from "./mcpEditing.fixture";

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
});
function status(): McpDesktopStatus {
  return {
    state: "online",
    provider: "tailscale",
    url: "https://carrot.tail-test.ts.net/mcp",
    message: null,
    setupUrl: null,
    preferences: { allowImages: false, allowEditing: false, autoStart: false },
    pairingUntil: null,
    pending: [],
    connections: [],
  };
}
function show(value = status(), busy = false) {
  return render(
    <McpSettingsView
      status={value}
      busy={busy}
      error={null}
      diagnostics={null}
      run={async (action) => {
        await action();
      }}
      diagnose={async () => {}}
    />,
  );
}
it("routes the actual settings controls to app stop, stable URL copy and edit opt-in", async () => {
  const current = status();
  const setMcpEnabled = vi.fn(async () => current);
  const copyMcpUrl = vi.fn(async () => ({ completed: true }));
  const configureMcp = vi.fn(async () => current);
  window.mangaApi = createTestMangaGatewayStub({
    setMcpEnabled,
    copyMcpUrl,
    configureMcp,
  });
  show(current);
  fireEvent.click(screen.getByRole("button", { name: "MCP 끄기" }));
  fireEvent.click(screen.getByRole("button", { name: "고정 주소 복사" }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: "기존 블록의 번역문 수정 허용" }),
  );
  await waitFor(() => expect(setMcpEnabled).toHaveBeenCalledWith(false));
  expect(copyMcpUrl).toHaveBeenCalledOnce();
  expect(configureMcp).toHaveBeenCalledWith({
    ...current.preferences,
    allowEditing: true,
  });
});
it("lets the user retry a stopped connection cleanup instead of disabling the stop button", async () => {
  const current = { ...status(), state: "stopping" as const };
  const setMcpEnabled = vi.fn(async () => ({
    ...current,
    state: "off" as const,
  }));
  window.mangaApi = createTestMangaGatewayStub({ setMcpEnabled });
  show(current, true);
  fireEvent.click(screen.getByRole("button", { name: "MCP 끄기" }));
  await waitFor(() => expect(setMcpEnabled).toHaveBeenCalledWith(false));
});
it("approves the selected comparison code through the app, without a password field", async () => {
  const current = status();
  current.pending = [
    {
      id: "a".repeat(43),
      clientName: "ChatGPT",
      code: "739412",
      scope: "carrot.read",
      expiresAt: Date.now() + 60000,
    },
  ];
  const resolveMcpPairing = vi.fn(async () => current);
  window.mangaApi = createTestMangaGatewayStub({ resolveMcpPairing });
  show(current);
  expect(screen.getByText(/739412/)).toBeTruthy();
  expect(document.querySelector('input[type="password"]')).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "같은 코드 확인 · 승인" }),
  );
  await waitFor(() =>
    expect(resolveMcpPairing).toHaveBeenCalledWith("a".repeat(43), true),
  );
});
it("answers main-process probes with the latest unsaved editor state and removes listeners on unmount", async () => {
  let probe: ((value: { id: number }) => void) | undefined;
  const offProbe = vi.fn(),
    offPages = vi.fn();
  const reportMcpEditorState = vi.fn(async () => ({ completed: true }));
  window.mangaApi = createTestMangaGatewayStub({
    reportMcpEditorState,
    onMcpEditorProbe: (listener) => {
      probe = listener;
      return offProbe;
    },
    onMcpPageChanged: () => offPages,
  });
  const chapter = editingChapter();
  const dirty = new Set<string>();
  const options = {
    currentChapterRef: { current: chapter },
    dirtyPageIdsRef: { current: dirty },
    hasPendingInpaintingMask: false,
    mergeLiveChapter: vi.fn(),
  };
  const hook = renderHook(() => useMcpEditorSync(options));
  expect(reportMcpEditorState).not.toHaveBeenCalled();
  dirty.add("page");
  probe?.({ id: 42 });
  await waitFor(() =>
    expect(reportMcpEditorState).toHaveBeenCalledWith({
      probeId: 42,
      chapterId: chapter.id,
      dirtyPageIds: ["page"],
      hasPendingInpaintingMask: false,
    }),
  );
  hook.unmount();
  expect(offProbe).toHaveBeenCalledOnce();
  expect(offPages).toHaveBeenCalledOnce();
});
it("refreshes remote saves through the existing live-merge path, not a direct replacement", async () => {
  let pages: ((value: McpPageChangedEvent) => void) | undefined;
  const chapter = editingChapter();
  const openChapter = vi.fn(async () => chapter);
  const mergeLiveChapter = vi.fn();
  window.mangaApi = createTestMangaGatewayStub({
    openChapter,
    onMcpPageChanged: (listener) => {
      pages = listener;
      return vi.fn();
    },
  });
  renderHook(() =>
    useMcpEditorSync({
      currentChapterRef: { current: chapter },
      dirtyPageIdsRef: { current: new Set(["page"]) },
      hasPendingInpaintingMask: false,
      mergeLiveChapter,
    }),
  );
  pages?.({ chapterId: "another-chapter", pageIds: ["page"] });
  expect(openChapter).not.toHaveBeenCalled();
  pages?.({ chapterId: chapter.id, pageIds: ["page"] });
  await waitFor(() => expect(mergeLiveChapter).toHaveBeenCalledWith(chapter));
  expect(openChapter).toHaveBeenCalledWith(chapter.id);
});
