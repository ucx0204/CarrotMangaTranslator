/** @vitest-environment jsdom */
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeAppI18n } from "../src/renderer/src/appI18n";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { createAccountConnection } from "../src/renderer/src/api/accountConnection";
import { grokConnection } from "../src/renderer/src/api/grokConnection";
import { codexConnection } from "../src/renderer/src/api/codexConnection";
import { GrokAccountSection } from "../src/renderer/src/components/settingsModal/GrokAccountSection";
import { ChatPanel } from "../src/renderer/src/features/chat/ChatPanel";
import type { MangaApi } from "../src/shared/mangaApi";
import type { AppOperationActivityEvent } from "../src/shared/appOperationTypes";
import type { ChatSession } from "../src/shared/chatTypes";
import type { GrokAccount } from "../src/shared/grokTypes";

const grokMissing: GrokAccount = {
  authenticated: false,
  runtimeInstalled: false,
  version: "",
  models: [],
};
const grokConnected: GrokAccount = {
  authenticated: true,
  runtimeInstalled: true,
  version: "1.0.77",
  models: [
    {
      id: "grok-build",
      displayName: "Grok Build",
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
      isDefault: true,
    },
  ],
};

let listeners: Set<(event: AppOperationActivityEvent) => void>;
let updatedAt = 1;
const cancel = vi.fn<MangaApi["cancelAppOperation"]>(async () => ({
  accepted: true,
}));

function emit(patch: Partial<AppOperationActivityEvent>) {
  const event: AppOperationActivityEvent = {
    id: "grok-1",
    kind: "grok-auth",
    status: "running",
    phase: "cli-downloading",
    progressCurrent: 3 * 1024 * 1024,
    progressTotal: 40 * 1024 * 1024,
    progressUnit: "bytes",
    mutatesLibrary: false,
    cancellable: true,
    startedAt: 1,
    updatedAt: updatedAt++,
    ...patch,
  };
  act(() => listeners.forEach((listener) => listener(event)));
  return event;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installBridge(overrides: Partial<MangaApi>): void {
  window.mangaApi = createTestMangaGatewayStub({
    onAppOperationActivity: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancelAppOperation: cancel,
    ...overrides,
  });
}

function session(
  runtime: ChatSession["runtime"],
  patch: Partial<ChatSession> = {},
): ChatSession {
  return {
    version: 1,
    id: `00000000-0000-4000-a000-00000000000${runtime.length}`,
    title: "대화",
    runtime,
    nativeThreadId: null,
    model: null,
    effort: null,
    state: "idle",
    createdAt: 1,
    updatedAt: 1,
    items: [],
    checkpoint: [],
    question: null,
    ...patch,
  };
}

beforeEach(async () => {
  await initializeAppI18n("ko");
  listeners = new Set();
  cancel.mockClear();
});
afterEach(cleanup);

describe("Grok app-chat account management", () => {
  it("shows loading, a versionless account and a recoverable refresh error", async () => {
    const pending = deferred<GrokAccount>();
    const read = vi
      .fn<MangaApi["getGrokAccount"]>()
      .mockReturnValueOnce(pending.promise);
    installBridge({ getGrokAccount: read });
    grokConnection.publish(null);
    render(<GrokAccountSection />);
    expect(screen.getByText("계정 상태 확인 중…")).toBeTruthy();
    await act(async () => pending.resolve({ ...grokConnected, version: "" }));
    expect(await screen.findByText("Grok 연결됨")).toBeTruthy();
    read.mockRejectedValueOnce(new Error("refresh unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    read.mockResolvedValue(grokMissing);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(
      screen.getByRole("button", { name: "내려받고 Grok 로그인" }),
    ).toBeTruthy();
  });

  it("downloads Grok Build on first sign-in with shared progress, cancel and retry, then connects and signs out", async () => {
    const first = deferred<GrokAccount>();
    const login = vi
      .fn<MangaApi["loginGrokAccount"]>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(grokConnected);
    const logout = vi.fn<MangaApi["logoutGrokAccount"]>(async () => ({
      ...grokConnected,
      authenticated: false,
    }));
    const read = vi.fn<MangaApi["getGrokAccount"]>(async () => grokMissing);
    installBridge({
      getGrokAccount: read,
      loginGrokAccount: login,
      logoutGrokAccount: logout,
    });
    grokConnection.publish(grokMissing);
    render(<GrokAccountSection />);

    expect(
      screen.getByRole("region", { name: "앱 채팅 · Grok 계정" }),
    ).toBeTruthy();
    expect(screen.queryByText(/외부 AI 앱 연결\(MCP\)과는 별개/)).toBeNull();
    expect(
      screen.getByText("Grok Build 실행 파일이 아직 없습니다"),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "내려받고 Grok 로그인" }),
    );
    expect(login).toHaveBeenCalledOnce();
    const operation = emit({});
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.getByText(/Grok 계정 연결 · AI 실행 파일/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "새로고침" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "현재 작업 취소" }));
    expect(cancel).toHaveBeenCalledWith(operation.id);

    emit({ status: "failed", phase: undefined });
    await act(async () => first.reject(new Error("download interrupted")));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Grok Build 실행 파일을 내려받지 못했습니다",
    );
    expect(read).toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "다시 내려받고 Grok 로그인" }),
    );
    expect(
      await screen.findByText("Grok 연결됨 · Grok Build 1.0.77"),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    await screen.findByText("로그인되지 않음");
    expect(logout).toHaveBeenCalledOnce();
  });
});

describe("Grok in app chat", () => {
  it("offers Grok in the assistant picker and labels its history and replies", async () => {
    const codex = session("codex");
    const grok = session("grok", {
      title: "Grok 대화",
      items: [
        {
          id: "reply",
          role: "assistant",
          state: "completed",
          createdAt: 2,
          text: "번역을 확인했습니다.",
        },
      ],
    });
    const create = vi.fn<MangaApi["createChat"]>(async () => grok);
    installBridge({
      listChats: async () => [codex],
      readChat: async (id) => (id === grok.id ? grok : codex),
      createChat: create,
      onChatEvent: () => () => undefined,
      getCodexAccount: async () => ({
        authenticated: true,
        accountKind: "chatgpt",
        email: null,
        planType: null,
        requiresOpenaiAuth: true,
        appServerVersion: "test",
        models: [],
      }),
      getGrokAccount: async () => grokConnected,
    });
    codexConnection.publish(null);
    grokConnection.publish(grokConnected);
    render(<ChatPanel enabled />);
    fireEvent.click(
      await screen.findByRole("button", { name: /모델·추론 수준/ }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Grok" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("grok"));
    expect(await screen.findByText("번역을 확인했습니다.")).toBeTruthy();
    expect(screen.getByText("Grok", { selector: "strong" })).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "이전 대화" }).textContent,
    ).toContain("Grok · Grok 대화");
    expect(
      screen.getByRole("button", { name: /모델·추론 수준/ }).textContent,
    ).toContain("Grok · Grok Build");
  });

  it("signs in to Grok from chat and ignores another assistant's sign-in", async () => {
    const grok = session("grok");
    const login = vi.fn<MangaApi["loginGrokAccount"]>(
      () => new Promise<GrokAccount>(() => undefined),
    );
    installBridge({
      listChats: async () => [grok],
      readChat: async () => grok,
      onChatEvent: () => () => undefined,
      getGrokAccount: async () => grokMissing,
      loginGrokAccount: login,
    });
    grokConnection.publish(grokMissing);
    render(<ChatPanel enabled />);
    const button = await screen.findByRole("button", {
      name: "내려받고 Grok 로그인",
    });
    expect(screen.queryByText(/공식 Grok Build 실행 파일을/)).toBeNull();

    emit({ id: "claude-1", kind: "claude-auth" });
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(button).toHaveProperty("disabled", false);

    fireEvent.click(button);
    expect(login).toHaveBeenCalledOnce();
    const operation = emit({ kind: "grok-auth", startedAt: 2 });
    expect(screen.getByRole("progressbar")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "현재 작업 취소" }));
    expect(cancel).toHaveBeenCalledWith(operation.id);
    emit({
      startedAt: 2,
      phase: "codex-auth-opening-browser",
      progressCurrent: undefined,
      progressTotal: undefined,
      progressUnit: undefined,
      cancellable: false,
    });
    expect(
      screen.getByRole("progressbar").getAttribute("aria-valuenow"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "현재 작업 취소" })).toBeNull();
    emit({ startedAt: 2, status: "cancelling", cancellable: false });
    expect(
      screen.getByRole("button", { name: "취소 요청 중…" }),
    ).toHaveProperty("disabled", true);
  });
});

it("settles an account read that throws synchronously as a rejected refresh", async () => {
  const connection = createAccountConnection<GrokAccount>(() => {
    throw new Error("bridge missing");
  });
  await expect(connection.refresh()).rejects.toThrow("bridge missing");
  expect(connection.isChecked()).toBe(true);
  expect(connection.getSnapshot()).toBeNull();
  // Finish the initial loading state and permit a later focus/poll retry.
  await expect(connection.refresh()).rejects.toThrow("bridge missing");
});

it("sends selected images with a Grok message through the shared composer", async () => {
  const grok = session("grok");
  const attachChatImage = vi.fn<MangaApi["attachChatImage"]>(
    async (_id, name, dataUrl) => ({ id: "image-1", name, dataUrl }),
  );
  const sendChat = vi.fn<MangaApi["sendChat"]>(async () => ({
    ...grok,
    state: "running",
  }));
  installBridge({
    listChats: async () => [grok],
    readChat: async () => grok,
    onChatEvent: () => () => undefined,
    getGrokAccount: async () => grokConnected,
    attachChatImage,
    sendChat,
  });
  grokConnection.publish(grokConnected);
  render(<ChatPanel enabled />);
  const input = await screen.findByRole("textbox", { name: "메시지" });
  await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
  const picker = screen.getByLabelText("이미지 첨부", { selector: "input" });
  expect(picker.hasAttribute("disabled")).toBe(false);
  const image = new File([new Uint8Array([137, 80, 78, 71])], "page.png", {
    type: "image/png",
  });
  fireEvent.change(picker, { target: { files: [image] } });
  await waitFor(() =>
    expect(attachChatImage).toHaveBeenCalledWith(
      grok.id,
      "page.png",
      expect.stringMatching(/^data:image\/png;base64,/),
    ),
  );
  expect(await screen.findByRole("img", { name: "page.png" })).toBeTruthy();
  expect(screen.queryByText(/지원하지 않/)).toBeNull();

  fireEvent.change(input, {
    target: { value: "이 그림의 숨은 문구를 읽어줘" },
  });
  fireEvent.click(screen.getByRole("button", { name: /보내기/ }));
  await waitFor(() => expect(sendChat).toHaveBeenCalledOnce());
  expect(sendChat.mock.calls[0]?.[0]).toMatchObject({
    sessionId: grok.id,
    text: "이 그림의 숨은 문구를 읽어줘",
    imageIds: ["image-1"],
  });
});
