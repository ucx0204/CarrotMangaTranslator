/** @vitest-environment jsdom */
import React from "react";
import {
  cleanup,
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_MCP_PREFERENCES,
  type McpDesktopStatus,
} from "../src/shared/mcpDesktopTypes";
import type { McpPageChangedEvent } from "../src/shared/mcpEditingTypes";
import { useMcpSettings } from "../src/renderer/src/components/settingsModal/useMcpSettings";
import { McpSettingsView } from "../src/renderer/src/components/settingsModal/McpSettingsPanel";
import { useMcpEditorSync } from "../src/renderer/src/hooks/useMcpEditorSync";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { editingChapter } from "./mcpEditing.fixture";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
    screen.getByRole("checkbox", { name: "텍스트·서식·문맥 편집 허용" }),
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
  expect(resolveMcpPairing).not.toHaveBeenCalled();
  expect(screen.getByText("요청 권한: 보관함·텍스트·문맥 조회")).toBeTruthy();
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
    setLibrary: vi.fn(),
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
      setLibrary: vi.fn(),
    }),
  );
  pages?.({ chapterId: "another-chapter", pageIds: ["page"] });
  expect(openChapter).not.toHaveBeenCalled();
  pages?.({ chapterId: chapter.id, pageIds: ["page"] });
  await waitFor(() => expect(mergeLiveChapter).toHaveBeenCalledWith(chapter));
  expect(openChapter).toHaveBeenCalledWith(chapter.id);
});

it("does not duplicate polling when StrictMode replays an unresolved initial effect", async () => {
  vi.useFakeTimers();
  let resolveOld!: (value: McpDesktopStatus) => void;
  const old = new Promise<McpDesktopStatus>((resolve) => {
    resolveOld = resolve;
  });
  const getMcpStatus = vi
    .fn()
    .mockImplementationOnce(() => old)
    .mockResolvedValue(status());
  window.mangaApi = createTestMangaGatewayStub({ getMcpStatus });
  const hook = renderHook(() => useMcpSettings(), {
    reactStrictMode: true,
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(getMcpStatus).toHaveBeenCalledTimes(2);
  await act(async () => {
    resolveOld(status());
  });
  expect(vi.getTimerCount()).toBe(1);
  hook.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
it("ignores an obsolete polling failure after a newer stop action succeeds", async () => {
  let rejectOld!: (error: Error) => void;
  const old = new Promise<McpDesktopStatus>((_resolve, reject) => {
    rejectOld = reject;
  });
  const getMcpStatus = vi
    .fn()
    .mockImplementationOnce(() => old)
    .mockResolvedValue({ ...status(), state: "off" });
  window.mangaApi = createTestMangaGatewayStub({ getMcpStatus });
  const hook = renderHook(() => useMcpSettings());
  await act(async () => {
    await hook.result.current.run(async () => {});
  });
  await act(async () => {
    rejectOld(new Error("obsolete read failure"));
  });
  expect(hook.result.current.status?.state).toBe("off");
  expect(hook.result.current.error).toBeNull();
});
it("clears a transient polling error after status recovery without hiding action errors", async () => {
  vi.useFakeTimers();
  const getMcpStatus = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporarily unavailable"))
    .mockResolvedValue(status());
  window.mangaApi = createTestMangaGatewayStub({ getMcpStatus });
  const hook = renderHook(() => useMcpSettings());
  await act(async () => {
    await Promise.resolve();
  });
  expect(hook.result.current.error).toBe("temporarily unavailable");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(hook.result.current.error).toBeNull();
  await act(async () => {
    await hook.result.current.run(async () => {
      throw new Error("save failed");
    });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(hook.result.current.error).toBe("save failed");
});

it("renders human-readable permissions and preserves unrecognized scope text safely", () => {
  const current = status();
  current.connections = [
    {
      id: "connection",
      clientName: "<img src=x>",
      scope:
        " carrot.read   carrot.images carrot.edit carrot.process offline_access custom.permission constructor __proto__ toString ",
      createdAt: 1,
      revoked: false,
    },
  ];
  show(current);
  expect(
    screen.getByText(
      /이미지 및 이미지 포함 파일 전송.*텍스트·서식·문맥 편집.*블록·보관함 관리와 앱 모델 처리/,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      /다음 실행에도 승인 유지.*custom.permission · constructor · __proto__ · toString/,
    ),
  ).toBeTruthy();
  expect(screen.getByText("<img src=x>")).toBeTruthy();
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByText(/외부 제공자를 사용하는 작업은/)).toBeTruthy();
  expect(screen.getByText(/텍스트·문맥 파일 출력에 적용됩니다/)).toBeTruthy();
  expect(
    screen.getByRole("checkbox", {
      name: "이미지와 이미지 포함 출력 파일 전송 허용",
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole("checkbox", {
      name: "블록·보관함 관리 및 앱 모델 처리 허용",
    }),
  ).toBeTruthy();
});

it("shows all first-use options checked and receives requests online without an enrollment button", () => {
  const current = { ...status(), preferences: { ...DEFAULT_MCP_PREFERENCES } };
  const view = show(current);
  const options = screen.getAllByRole("checkbox") as HTMLInputElement[];
  expect(options).toHaveLength(4);
  expect(options.every((option) => option.checked)).toBe(true);
  expect(screen.queryByRole("button", { name: /새 연결 허용/ })).toBeNull();
  expect(screen.getByText(/새 연결 요청을 항상 받습니다/)).toBeTruthy();
  view.unmount();
  show({ ...current, state: "off" });
  expect(screen.queryByText(/새 연결 요청을 항상 받습니다/)).toBeNull();
  expect(screen.getByText(/MCP를 켜면 새 연결 요청을 받습니다/)).toBeTruthy();
});
