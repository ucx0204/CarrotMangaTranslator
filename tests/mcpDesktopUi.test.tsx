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
import {
  McpSettingsPanel,
  McpSettingsView,
} from "../src/renderer/src/components/settingsModal/McpSettingsPanel";
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
it("shows distinct Codex and ChatGPT setup steps and copies the actual server commands", async () => {
  const copy = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  show();
  fireEvent.click(screen.getByRole("button", { name: "연결 방법 및 도움말" }));
  expect(
    screen.getByRole("tab", { name: "Codex" }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "명령 복사" }));
  await waitFor(() =>
    expect(copy).toHaveBeenCalledWith(
      'codex mcp add carrot --url "https://carrot.tail-test.ts.net/mcp"\ncodex mcp login carrot',
    ),
  );
  expect(screen.getByRole("button", { name: "복사됨" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("tab", { name: "Codex" }), {
    key: "ArrowRight",
  });
  expect(
    screen.getByRole("tab", { name: "ChatGPT" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByText("추가 → MCP 앱 만들기")).toBeTruthy();
  expect(screen.getByText(/⋯ → 관리/)).toBeTruthy();
  expect(screen.getByText(/모든 도구 허용을 선택하면/)).toBeTruthy();
  expect(screen.getByText(/편집·삭제 같은 변경도 확인 없이/)).toBeTruthy();
  expect(
    screen.getAllByRole("img").map((image) => image.getAttribute("alt")),
  ).toEqual([
    "왼쪽 패널의 플러그인 아이콘",
    "추가 메뉴의 MCP 앱 만들기",
    "MCP 앱 만들기 · 연결 주소는 가린 예시",
    "설치된 플러그인의 당근망가번역기",
    "플러그인 더보기 메뉴의 관리",
    "관리 화면의 권한 항목",
    "권한 메뉴의 모든 도구 허용",
  ]);
  fireEvent.click(
    screen.getByRole("button", {
      name: "MCP 앱 만들기 · 연결 주소는 가린 예시 · 크게 보기",
    }),
  );
  expect(
    screen.getByRole("dialog", {
      name: "MCP 앱 만들기 · 연결 주소는 가린 예시",
    }),
  ).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "명령 복사" })).toBeNull();
});
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
  fireEvent.click(screen.getByRole("button", { name: "주소 복사" }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: "텍스트·서식·문맥 편집" }),
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
  fireEvent.click(screen.getByRole("button", { name: "코드 확인 · 승인" }));
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
  expect(openChapter).toHaveBeenCalledWith(chapter.id, chapter.workId);
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
    screen.getByTitle(
      /이미지 및 이미지 포함 파일 전송.*텍스트·서식·문맥 편집.*블록·보관함 관리와 앱 모델 처리/,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      /승인 유지.*custom.permission · constructor · __proto__ · toString/,
    ),
  ).toBeTruthy();
  expect(screen.getByText("<img src=x>")).toBeTruthy();
  expect(document.querySelector("img")).toBeNull();
  expect(screen.queryByText(/외부 AI로 처리하면/)).toBeNull();
  expect(
    screen.getByText(/보관함 텍스트·문맥 조회와 텍스트 파일 출력/),
  ).toBeTruthy();
  expect(
    screen.getByRole("checkbox", {
      name: "이미지·출력 파일 전송",
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole("checkbox", {
      name: "블록·보관함 관리 및 OCR·번역 실행",
    }),
  ).toBeTruthy();
});

it("shows Claude connector screenshots and a separate Claude Code tab", async () => {
  const copy = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  show();
  fireEvent.click(screen.getByRole("button", { name: "연결 방법 및 도움말" }));
  fireEvent.click(screen.getByRole("tab", { name: "Claude" }));
  expect(
    screen.getByRole("tab", { name: "Claude" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByText("커넥터 → 추가 → 커스텀 커넥터 추가")).toBeTruthy();
  expect(
    screen.getAllByRole("img").map((image) => image.getAttribute("alt")),
  ).toEqual([
    "이름 메뉴의 설정",
    "설정의 커넥터 화면",
    "추가 메뉴의 커스텀 커넥터 추가",
    "커스텀 커넥터 이름·주소 입력 · 연결 주소는 가린 예시",
    "커스텀 커넥터 인증 설정 · 연결 주소는 가린 예시",
    "커넥터의 연결 버튼 · 연결 주소는 가린 예시",
  ]);
  expect(screen.queryByRole("button", { name: "명령 복사" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }));
  fireEvent.click(screen.getByRole("button", { name: "명령 복사" }));
  await waitFor(() =>
    expect(copy).toHaveBeenCalledWith(
      'claude mcp add --transport http --scope user carrot "https://carrot.tail-test.ts.net/mcp"',
    ),
  );
});

it("copies OpenCode-only settings and explains generic HTTP OAuth without a shared config format", async () => {
  const copy = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
  const openMcpHelp = vi.fn(async () => ({ completed: true }));
  window.mangaApi = createTestMangaGatewayStub({ openMcpHelp });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  show();
  fireEvent.click(screen.getByRole("button", { name: "연결 방법 및 도움말" }));
  fireEvent.click(screen.getByRole("tab", { name: "OpenCode" }));
  fireEvent.click(screen.getByRole("button", { name: "설정 복사" }));
  await waitFor(() => expect(copy).toHaveBeenCalledOnce());
  expect(JSON.parse(copy.mock.calls[0][0])).toEqual({
    mcp: {
      carrot: {
        type: "remote",
        url: status().url,
        enabled: true,
        oauth: {},
      },
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "인증 명령 복사" }));
  await waitFor(() =>
    expect(copy).toHaveBeenCalledWith(
      "opencode mcp auth carrot\nopencode mcp list",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "OpenCode 연결 문서" }));
  await waitFor(() => expect(openMcpHelp).toHaveBeenCalledWith("opencode"));
  fireEvent.click(screen.getByRole("tab", { name: "기타 MCP 앱" }));
  expect(screen.getByText("OAuth")).toBeTruthy();
  expect(screen.getByText("HTTP (Streamable HTTP)")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "설정 복사" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "MCP 연결 문서" }));
  await waitFor(() => expect(openMcpHelp).toHaveBeenCalledWith("generic"));
});

it("connects Grok web and Build through their own help routes and copies the live CLI address", async () => {
  const copy = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
  const openMcpHelp = vi.fn(async () => ({ completed: true }));
  window.mangaApi = createTestMangaGatewayStub({ openMcpHelp });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  show();
  fireEvent.click(screen.getByRole("button", { name: "연결 방법 및 도움말" }));
  fireEvent.click(screen.getByRole("tab", { name: "Grok 웹" }));
  expect(screen.getByText(/OAuth 인증/)).toBeTruthy();
  expect(screen.getByText(/맞춤 모드\(Custom\)/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "명령 복사" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Grok 커넥터 열기" }));
  await waitFor(() => expect(openMcpHelp).toHaveBeenCalledWith("grok"));
  fireEvent.keyDown(screen.getByRole("tab", { name: "Grok 웹" }), {
    key: "ArrowRight",
  });
  expect(
    screen
      .getByRole("tab", { name: "Grok Build" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "명령 복사" }));
  await waitFor(() =>
    expect(copy).toHaveBeenCalledWith(
      'grok mcp add --transport http carrot "https://carrot.tail-test.ts.net/mcp"\ngrok mcp list',
    ),
  );
  expect(screen.getByText(/grok mcp doctor carrot/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Grok Build 연결 문서" }));
  await waitFor(() => expect(openMcpHelp).toHaveBeenCalledWith("grok-build"));
});

it("does not offer Grok commands without a server address and disables actions while busy", () => {
  const view = show({ ...status(), state: "off", url: null });
  fireEvent.click(screen.getByRole("tab", { name: "Grok Build" }));
  expect(screen.queryByRole("button", { name: "명령 복사" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Grok 웹" }));
  expect(screen.getByText("MCP를 켜면 표시됩니다.")).toBeTruthy();
  view.unmount();
  show(status(), true);
  fireEvent.click(screen.getByRole("button", { name: "연결 방법 및 도움말" }));
  fireEvent.click(screen.getByRole("tab", { name: "Grok Build" }));
  for (const name of ["명령 복사", "Grok Build 연결 문서"]) {
    expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(
      true,
    );
  }
});

it("shows the actual OAuth callback next to the unverified client name", () => {
  const current = status();
  const redirectUri = "http://127.0.0.1:19876/mcp/oauth/callback";
  current.pending = [
    {
      id: "pending",
      clientName: "OpenCode",
      redirectUri,
      code: "123456",
      scope: "carrot.read",
      expiresAt: Date.now() + 300_000,
    },
  ];
  show(current);
  expect(screen.getByText(redirectUri)).toBeTruthy();
  expect(screen.getByText("요청 앱이 표시한 이름: OpenCode")).toBeTruthy();
});

it("shows all first-use options checked and receives requests online without an enrollment button", () => {
  const current = { ...status(), preferences: { ...DEFAULT_MCP_PREFERENCES } };
  const view = show(current);
  const options = screen.getAllByRole("checkbox") as HTMLInputElement[];
  expect(options).toHaveLength(4);
  expect(options.every((option) => option.checked)).toBe(true);
  expect(screen.queryByRole("button", { name: /새 연결 허용/ })).toBeNull();
  expect(screen.getByText(/연결 방법에서 앱을 선택하세요/)).toBeTruthy();
  view.unmount();
  show({ ...current, state: "off" });
  expect(screen.queryByText(/새 연결 요청을 항상 받습니다/)).toBeNull();
  expect(screen.getByText(/MCP를 켜세요/)).toBeTruthy();
});

it("hides historical revoked grants and removes a newly revoked connection after the action refresh", async () => {
  const current = status();
  current.connections = [
    {
      id: "old",
      clientName: "Old ChatGPT",
      scope: "carrot.read",
      createdAt: 1,
      revoked: true,
    },
    {
      id: "active",
      clientName: "Current ChatGPT",
      scope: "carrot.read",
      createdAt: 2,
      revoked: false,
    },
  ];
  const revokeMcpConnection = vi.fn(async (id: string) => {
    current.connections = current.connections.map((item) =>
      item.id === id ? { ...item, revoked: true } : item,
    );
    return current;
  });
  window.mangaApi = createTestMangaGatewayStub({
    getMcpStatus: async () => structuredClone(current),
    revokeMcpConnection,
  });
  const first = render(<McpSettingsPanel />);
  const disconnect = await screen.findByRole("button", {
    name: "Current ChatGPT 연결 해제",
  });
  expect(screen.queryByText("Old ChatGPT")).toBeNull();
  fireEvent.click(disconnect);
  await waitFor(() => expect(screen.queryByText("Current ChatGPT")).toBeNull());
  expect(revokeMcpConnection).toHaveBeenCalledWith("active");
  expect(screen.getByText(/연결된 앱이 없습니다/)).toBeTruthy();
  first.unmount();
  render(<McpSettingsPanel />);
  await screen.findByText(/연결된 앱이 없습니다/);
  expect(screen.queryByRole("button", { name: /연결 해제/ })).toBeNull();
});

it("retains a connection and shows the failure when revocation fails", async () => {
  const current = status();
  current.connections = [
    {
      id: "active",
      clientName: "ChatGPT",
      scope: "carrot.read",
      createdAt: 1,
      revoked: false,
    },
  ];
  window.mangaApi = createTestMangaGatewayStub({
    getMcpStatus: async () => current,
    revokeMcpConnection: async () => {
      throw new Error("권한 철회 실패");
    },
  });
  render(<McpSettingsPanel />);
  fireEvent.click(
    await screen.findByRole("button", { name: "ChatGPT 연결 해제" }),
  );
  expect((await screen.findByRole("alert")).textContent).toBe("권한 철회 실패");
  expect(
    screen.getByRole("button", { name: "ChatGPT 연결 해제" }),
  ).toBeTruthy();
});

it("keeps setup and diagnostics behind an accessible disclosure and runs the selected actions", async () => {
  const current = status();
  const openMcpHelp = vi.fn(async () => ({ completed: true }));
  const diagnoseMcp = vi.fn(async () => ({
    ok: false,
    checks: [{ name: "OAuth", passed: false, message: "주소 확인 필요" }],
  }));
  window.mangaApi = createTestMangaGatewayStub({
    getMcpStatus: async () => current,
    openMcpHelp,
    diagnoseMcp,
  });
  render(<McpSettingsPanel />);
  await screen.findByText("연결 가능");
  expect(screen.queryByRole("button", { name: "연결 진단" })).toBeNull();
  const help = screen.getByRole("button", { name: "연결 방법 및 도움말" });
  expect(help.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(help);
  expect(help.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Tailscale 다운로드" }));
  await waitFor(() => expect(openMcpHelp).toHaveBeenCalledWith("tailscale"));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "연결 진단" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "연결 진단" }));
  await screen.findByText("실패 · OAuth: 주소 확인 필요");
  fireEvent.click(help);
  expect(screen.queryByRole("button", { name: "연결 진단" })).toBeNull();
});

it.each(["off", "error"] as const)(
  "opens the Tailscale steps after loading %s and keeps a saved URL from looking ready",
  async (state) => {
    const current = {
      ...status(),
      state,
      setupUrl:
        state === "error"
          ? "https://login.tailscale.com/f/funnel?node=fixture"
          : null,
    };
    const openMcpHelp = vi.fn(async () => ({ completed: true }));
    window.mangaApi = createTestMangaGatewayStub({
      getMcpStatus: async () => current,
      openMcpHelp,
    });
    render(<McpSettingsPanel />);
    const steps = await screen.findByRole("list", {
      name: "Tailscale 연결 순서",
    });
    expect(steps.children).toHaveLength(4);
    expect(
      screen
        .getByRole("button", { name: "연결 방법 및 도움말" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText(/Log in\(로그인\)/)).toBeTruthy();
    expect(screen.getByText(/당근에서 MCP 켜기를 다시/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "연결 진단" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "명령 복사" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tailscale 다운로드" }));
    await waitFor(() => expect(openMcpHelp).toHaveBeenCalledWith("tailscale"));
    if (state === "error") {
      fireEvent.click(
        screen.getByRole("button", { name: "Tailscale에서 연결 허용" }),
      );
      await waitFor(() => expect(openMcpHelp).toHaveBeenCalledWith("setup"));
    }
    fireEvent.click(
      screen.getByRole("button", { name: "연결 방법 및 도움말" }),
    );
    expect(
      screen.queryByRole("list", { name: "Tailscale 연결 순서" }),
    ).toBeNull();
  },
);
