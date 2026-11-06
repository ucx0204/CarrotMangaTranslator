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
import { afterEach, expect, it, vi } from "vitest";
import { ChatPanel } from "../src/renderer/src/features/chat/ChatPanel";
import { ChatMarkdown } from "../src/renderer/src/features/chat/ChatMarkdown";
import { ChatTranscript } from "../src/renderer/src/features/chat/ChatTranscript";
import { codexConnection } from "../src/renderer/src/api/codexConnection";
import { claudeConnection } from "../src/renderer/src/api/claudeConnection";
import type { MangaApi } from "../src/shared/mangaApi";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type {
  ChatApi,
  ChatEvent,
  ChatSession,
  CurrentViewContext,
} from "../src/shared/chatTypes";
import type { CodexAccountModel } from "../src/shared/codexAccountTypes";

afterEach(cleanup);
const DEFAULT_MODELS: CodexAccountModel[] = [
  {
    id: "gpt-6.1-sol",
    displayName: "GPT 6.1 SOL",
    supportedReasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
    isDefault: true,
  },
];
function setup(
  models: CodexAccountModel[] = DEFAULT_MODELS,
  extra: Partial<MangaApi> = {},
) {
  const session: ChatSession = {
    version: 1,
    id: "00000000-0000-4000-a000-000000000001",
    title: "대화",
    runtime: "codex",
    nativeThreadId: null,
    model: null,
    effort: null,
    state: "idle",
    createdAt: 1,
    updatedAt: 1,
    items: [],
    checkpoint: [],
    question: null,
  };
  let emit: (event: ChatEvent) => void = () => undefined;
  const send = vi.fn<ChatApi["sendChat"]>(async () => ({
    ...session,
    state: "running",
    updatedAt: 2,
  }));
  const stop = vi.fn<ChatApi["stopChat"]>(async () => ({
    ...session,
    state: "paused",
    updatedAt: 3,
  }));
  window.mangaApi = createTestMangaGatewayStub({
    listChats: async () => [session],
    readChat: async () => session,
    sendChat: send,
    stopChat: stop,
    onChatEvent: (callback) => {
      emit = callback;
      return () => undefined;
    },
    getCodexAccount: async () => ({
      authenticated: true,
      accountKind: "chatgpt",
      email: null,
      planType: "plus",
      requiresOpenaiAuth: true,
      appServerVersion: "0.167.0",
      models,
    }),
    ...extra,
  });
  return { session, send, stop, emit: (event: ChatEvent) => emit(event) };
}

it("continues in the same conversation without clearing an unfinished draft", async () => {
  const f = setup();
  render(<ChatPanel enabled />);
  const input = await screen.findByRole("textbox", { name: "메시지" });
  await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
  fireEvent.change(input, { target: { value: "나중에 보낼 추가 지시" } });
  act(() =>
    f.emit({
      sessionId: f.session.id,
      session: { ...f.session, state: "paused" },
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "이어서 진행" }));
  await waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  expect(f.send.mock.calls[0][0]).toMatchObject({
    sessionId: f.session.id,
    imageIds: [],
  });
  expect(f.send.mock.calls[0][0].text).toContain("중복 실행하지 마");
  expect((input as HTMLTextAreaElement).value).toBe("나중에 보낼 추가 지시");
});

it("deletes the selected session, ignores late events and creates a fresh chat after the last deletion", async () => {
  const remove = vi.fn<ChatApi["deleteChat"]>(async () => undefined);
  const create = vi.fn<ChatApi["createChat"]>(async () => ({
    ...f.session,
    id: "fresh",
    title: "새 대화",
  }));
  const f = setup(DEFAULT_MODELS, {
    deleteChat: remove,
    createChat: create,
    listChats: async () => [f.session, other],
    readChat: async (id) => (id === other.id ? other : f.session),
  });
  const other = {
    ...f.session,
    id: "other",
    title: "다른 대화",
    runtime: "claude" as const,
  };
  render(<ChatPanel enabled />);
  await screen.findByRole("combobox", { name: "이전 대화" });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "대화 삭제" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "대화 삭제" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith(f.session.id));
  await waitFor(() =>
    expect(screen.getByRole("combobox").textContent).toContain("다른 대화"),
  );
  act(() =>
    f.emit({
      sessionId: f.session.id,
      session: { ...f.session, updatedAt: 99 },
    }),
  );
  fireEvent.click(screen.getByRole("combobox"));
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "대화 삭제" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith("claude"));
  await waitFor(() =>
    expect(screen.getByRole("combobox").textContent).toContain("새 대화"),
  );
});

it("keeps the selected conversation when deletion fails and disables deletion while running", async () => {
  const f = setup(DEFAULT_MODELS, {
    deleteChat: async () => {
      throw new Error("삭제 실패");
    },
  });
  render(<ChatPanel enabled />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "대화 삭제" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "대화 삭제" }));
  expect((await screen.findByRole("alert")).textContent).toBe("삭제 실패");
  expect(screen.getByRole("combobox").textContent).toContain("대화");
  act(() =>
    f.emit({
      sessionId: f.session.id,
      session: { ...f.session, state: "running", updatedAt: 2 },
    }),
  );
  expect(
    screen.getByRole("button", { name: "대화 삭제" }).hasAttribute("disabled"),
  ).toBe(true);
});

it("switches runtimes and logs into the chosen account, keeping new conversations in that runtime", async () => {
  const claudeAccount = {
    authenticated: false,
    email: null,
    plan: null,
    version: "test",
    models: [],
  };
  const loginClaude = vi.fn(async () => claudeAccount);
  const loginCodex = vi.fn(async () => ({
    authenticated: false,
    accountKind: null,
    email: null,
    planType: null,
    requiresOpenaiAuth: true,
    appServerVersion: "test",
    models: [],
  }));
  const create = vi.fn<ChatApi["createChat"]>(async (runtime) => ({
    ...f.session,
    id: `session-${runtime}`,
    runtime: runtime ?? "codex",
  }));
  const f = setup([], {
    createChat: create,
    getClaudeAccount: async () => claudeAccount,
    loginClaudeAccount: loginClaude,
    getCodexAccount: loginCodex,
    loginCodexAccount: loginCodex,
  });
  claudeConnection.publish(claudeAccount);
  codexConnection.publish(null);
  render(<ChatPanel enabled />);
  await screen.findByRole("button", { name: /ChatGPT.*로그인/ });
  fireEvent.click(screen.getByRole("button", { name: /ChatGPT.*로그인/ }));
  await waitFor(() => expect(loginCodex.mock.calls.length).toBeGreaterThan(1));
  chooseRuntime("Claude");
  await screen.findByRole("button", { name: /Claude.*로그인/ });
  fireEvent.click(screen.getByRole("button", { name: /Claude.*로그인/ }));
  await waitFor(() => expect(loginClaude).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "새 대화" }));
  await waitFor(() => expect(create).toHaveBeenLastCalledWith("claude"));
  chooseRuntime("Codex");
  await waitFor(() => expect(create).toHaveBeenLastCalledWith("codex"));
});
const context: CurrentViewContext = {
  workId: null,
  workTitle: "작품 A",
  chapterId: null,
  chapterTitle: "1화",
  pageId: null,
  pageNumber: 1,
  blockIds: [],
};

it("replaces the whole conversation on repeated history switches without retaining old transcripts", async () => {
  const f = setup(DEFAULT_MODELS, {
    listChats: async () => [first, second],
    readChat: async (id) => (id === first.id ? first : second),
  });
  const first: ChatSession = {
    ...f.session,
    title: "첫 대화",
    items: [
      {
        id: "reply",
        role: "assistant",
        state: "completed",
        createdAt: 1,
        text: "첫 대화 내용",
      },
    ],
  };
  const second: ChatSession = {
    ...first,
    id: "second",
    title: "두 번째 대화",
    items: [],
  };
  codexConnection.publish(null);
  render(<ChatPanel enabled />);
  await screen.findByText("첫 대화 내용");
  for (let index = 0; index < 4; index++) {
    const next = index % 2 === 0 ? second : first;
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      await screen.findByRole("option", { name: `Codex · ${next.title}` }),
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox").textContent).toContain(next.title),
    );
    expect(screen.getAllByRole("log")).toHaveLength(1);
    expect(screen.getAllByRole("textbox", { name: "메시지" })).toHaveLength(1);
    expect(screen.queryAllByText("첫 대화 내용")).toHaveLength(
      next === first ? 1 : 0,
    );
  }
});

it("keeps a draft on panel/navigation changes and sends the new view only at send time", async () => {
  const f = setup();
  const view = render(<ChatPanel enabled context={context} />);
  const input = await screen.findByRole("textbox", { name: "메시지" });
  await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
  fireEvent.change(input, { target: { value: "이 화 번역해줘" } });
  view.rerender(
    <ChatPanel enabled={false} context={{ ...context, workTitle: "작품 B" }} />,
  );
  view.rerender(
    <ChatPanel enabled context={{ ...context, workTitle: "작품 B" }} />,
  );
  expect((input as HTMLTextAreaElement).value).toBe("이 화 번역해줘");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
  expect(f.send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  expect(f.send.mock.calls[0][0]).toMatchObject({
    context: { workTitle: "작품 B" },
    model: "gpt-6.1-sol",
    effort: "high",
  });
  fireEvent.click(await screen.findByRole("button", { name: "중지" }));
  await waitFor(() => expect(f.stop).toHaveBeenCalledWith(f.session.id));
});
it("ignores stale session events and preserves text typed while a send is awaiting acknowledgement", async () => {
  const f = setup();
  let accept!: (value: ChatSession) => void;
  f.send.mockImplementation(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  render(<ChatPanel enabled />);
  const input = await screen.findByRole("textbox", { name: "메시지" });
  await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
  fireEvent.change(input, { target: { value: "첫 요청" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  fireEvent.change(input, { target: { value: "추가로 쓴 요청" } });
  await act(async () =>
    accept({ ...f.session, state: "running", updatedAt: 20 }),
  );
  act(() =>
    f.emit({
      sessionId: f.session.id,
      session: { ...f.session, state: "idle", updatedAt: 10 },
    }),
  );
  expect((input as HTMLTextAreaElement).value).toBe("추가로 쓴 요청");
  expect(screen.getByRole("button", { name: "추가 지시" })).toBeTruthy();
});
it("renders tables while excluding model-supplied remote images, raw controls, and scripts", () => {
  const view = render(
    <ChatMarkdown
      text={
        "| A | B |\n|---|---|\n| 1 | 2 |\n\n![track](https://example.com/track.png)\n\n<script>alert(1)</script>\n<input autofocus />"
      }
    />,
  );
  expect(screen.getByRole("table")).toBeTruthy();
  expect(view.container.querySelector("img,script,input,iframe")).toBeNull();
});
it("keeps an empty conversation free of hints and folds model choice into one chip", async () => {
  setup();
  render(
    <ChatPanel
      enabled
      context={{
        ...context,
        chapterId: "chapter-1",
        pageId: "page-1",
        blockIds: ["block-1"],
      }}
    />,
  );
  const input = await screen.findByRole("textbox", { name: "메시지" });
  await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
  expect(input.getAttribute("placeholder")).toBe("요청 입력");
  expect(screen.getByText("1화 p.1 · 말풍선 1개")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("log").textContent).toBe("");
  expect(
    screen
      .getAllByRole("button")
      .some((button) => button.textContent?.includes("번역")),
  ).toBe(false);

  const chip = screen.getByRole("button", { name: /모델·추론 수준/ });
  expect(chip.textContent).toBe("Codex · GPT 6.1 SOL · 추론 높음");
  fireEvent.click(chip);
  expect(screen.getByRole("group", { name: "모델·추론 수준" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "추론 수준" })).toBeTruthy();
});
it("falls back to the model settings label without models and keeps select menus inside the popover", async () => {
  const createChat = vi.fn<ChatApi["createChat"]>(async () => ({
    ...f.session,
    id: "00000000-0000-4000-a000-000000000002",
  }));
  const f = setup([], { createChat });
  codexConnection.publish(null);
  await codexConnection.refresh();
  render(
    <ChatPanel
      enabled
      context={{ ...context, chapterId: "chapter-1", pageNumber: null }}
    />,
  );
  await screen.findByRole("textbox", { name: "메시지" });
  expect(screen.getByText("1화")).toBeTruthy();
  const chip = await screen.findByRole("button", { name: /모델·추론 수준/ });
  await waitFor(() => expect(chip.hasAttribute("disabled")).toBe(false));
  expect(chip.textContent).toBe("Codex");
  fireEvent.click(chip);
  const popover = screen.getByRole("group", { name: "모델·추론 수준" });
  fireEvent.click(screen.getByRole("combobox", { name: "모델" }));
  const menu = document.querySelector("[data-ui-select-menu]");
  const label = menu
    ? document.createTreeWalker(menu, NodeFilter.SHOW_TEXT).nextNode()
    : null;
  if (label) fireEvent.pointerDown(label);
  if (menu) fireEvent.pointerDown(menu);
  expect(popover.isConnected).toBe(true);
  const outside = document.body.appendChild(document.createTextNode("밖"));
  fireEvent.pointerDown(outside);
  await waitFor(() => expect(popover.isConnected).toBe(false));
  outside.remove();
  fireEvent.click(chip);
  const reopened = screen.getByRole("group", { name: "모델·추론 수준" });
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(reopened.isConnected).toBe(false));

  fireEvent.click(screen.getByRole("button", { name: "새 대화" }));
  await waitFor(() => expect(createChat).toHaveBeenCalledOnce());
});
it("shows conversation messages with their context and page actions", () => {
  const onPage = vi.fn();
  const onUndo = vi.fn();
  render(
    <ChatTranscript
      session={{
        version: 1,
        id: "00000000-0000-4000-a000-000000000003",
        title: "대화",
        runtime: "codex",
        nativeThreadId: null,
        model: null,
        effort: null,
        state: "idle",
        createdAt: 1,
        updatedAt: 1,
        checkpoint: [],
        question: null,
        items: [
          {
            id: "u1",
            role: "user",
            text: "이 화 번역해줘",
            state: "completed",
            createdAt: 1,
            context: { ...context, chapterTitle: "1화" },
          },
          {
            id: "a1",
            role: "assistant",
            text: "**완료**",
            state: "completed",
            createdAt: 2,
          },
          {
            id: "t1",
            role: "tool",
            text: "{}",
            state: "completed",
            createdAt: 3,
            toolName: "carrot_apply_translation_batch",
            chapterId: "chapter-1",
            pageId: "page-1",
          },
        ],
      }}
      onPage={onPage}
      onUndo={onUndo}
    />,
  );
  expect(screen.getByText("작품 A · 1화")).toBeTruthy();
  expect(screen.getByText("완료")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /페이지 편집/ }));
  fireEvent.click(screen.getByRole("button", { name: "페이지 열기" }));
  expect(onPage).toHaveBeenCalledWith("chapter-1", "page-1");
  fireEvent.click(screen.getByRole("button", { name: "되돌리기 확인" }));
  expect(onUndo).toHaveBeenCalledOnce();
});
it("attaches pasted images but leaves plain-text paste to the input", async () => {
  const attachChatImage = vi.fn<ChatApi["attachChatImage"]>(
    async (_id, name, dataUrl) => ({ id: "image-1", name, dataUrl }),
  );
  setup(DEFAULT_MODELS, { attachChatImage });
  render(<ChatPanel enabled context={context} />);
  const input = await screen.findByRole("textbox", { name: "메시지" });
  await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
  fireEvent.paste(input, { clipboardData: { files: [] } });
  expect(attachChatImage).not.toHaveBeenCalled();
  const image = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", {
    type: "image/png",
  });
  fireEvent.paste(input, { clipboardData: { files: [image] } });
  await waitFor(() => expect(attachChatImage).toHaveBeenCalledOnce());
  expect(await screen.findByRole("img", { name: "shot.png" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "이미지 제거" }));
  expect(screen.queryByRole("img", { name: "shot.png" })).toBeNull();
});
it("starts chat at high reasoning when the model supports it", async () => {
  setup([
    {
      id: "gpt-6.1-sol",
      displayName: "GPT 6.1 SOL",
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "low",
      isDefault: true,
    },
    {
      id: "gpt-mini",
      displayName: "GPT Mini",
      supportedReasoningEfforts: ["low", "medium"],
      defaultReasoningEffort: "medium",
      isDefault: false,
    },
  ]);
  codexConnection.publish(null);
  await codexConnection.refresh();
  render(<ChatPanel enabled context={context} />);
  const chip = await screen.findByRole("button", { name: /모델·추론 수준/ });
  await waitFor(() =>
    expect(chip.textContent).toBe("Codex · GPT 6.1 SOL · 추론 높음"),
  );
  fireEvent.click(chip);
  fireEvent.click(screen.getByRole("combobox", { name: "모델" }));
  fireEvent.click(await screen.findByRole("option", { name: "GPT Mini" }));
  await waitFor(() =>
    expect(chip.textContent).toBe("Codex · GPT Mini · 추론 중간"),
  );
});

/** The assistant is chosen in the chip's popover and starts a new chat. */
function chooseRuntime(name: "Codex" | "Claude") {
  fireEvent.click(screen.getByRole("button", { name: /모델·추론 수준/ }));
  fireEvent.click(screen.getByRole("radio", { name }));
}
it("folds runs of tool calls into one row with thumbnails and live activity without an automatic quality banner", async () => {
  window.mangaApi = createTestMangaGatewayStub({
    readChatImage: async (_session, id) => ({
      id,
      name: `image ${id}`,
      dataUrl: "data:image/png;base64,AA==",
    }),
  });
  const pageId = (n: number) => `00000000-0000-4000-a000-00000000000${n}`;
  const receipt = {
    completion: {
      scope: "whole-chapter",
      status: "incomplete",
      chapterPageCount: 2,
      checkedPages: 2,
      acceptedPages: 0,
      pages: [1, 2].map((n) => ({
        pageId: pageId(n),
        revision: "page-v1:0123456789abcdef",
        status: "pending",
        reason: "No retained v2 review covers this page.",
      })),
      fontSubstitutions: [],
      nextAction: "review",
      observation: "current-owned-v2-evidence; not-an-aesthetic-guarantee",
    },
  };
  const tool = (id: string, toolName: string, extra = {}) => ({
    id,
    role: "tool" as const,
    state: "completed" as const,
    createdAt: 2,
    text: "{}",
    toolName,
    ...extra,
  });
  render(
    <ChatTranscript
      session={{
        version: 1,
        id: "00000000-0000-4000-a000-000000000004",
        title: "대화",
        runtime: "claude",
        nativeThreadId: null,
        model: null,
        effort: null,
        state: "running",
        createdAt: 1,
        updatedAt: 1,
        checkpoint: [],
        question: null,
        items: [
          tool("t1", "carrot_get_translation_guide", {
            text: JSON.stringify(receipt),
          }),
          tool("t2", "carrot_get_page_crop", {
            imageIds: ["i1", "i2", "i3"],
          }),
          tool("t3", "carrot_render_page_preview", {
            imageIds: ["i4", "i5", "i6"],
          }),
          tool("t4", "carrot_get_translation_guide"),
        ],
      }}
      onUndo={vi.fn()}
    />,
  );
  const group = screen.getByRole("button", { name: /도구 4개/ });
  expect(group.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: /이미지 작업/ })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("작업 중…");
  expect(await screen.findAllByRole("img")).toHaveLength(4);

  expect(screen.queryByText("미검수·해결할 항목 있음")).toBeNull();
  expect(screen.queryByRole("button", { name: "미검수 사유" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "이미지 2개 더 보기" }));
  expect(group.getAttribute("aria-expanded")).toBe("true");
  await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(6));
  expect(screen.getAllByRole("button", { name: /이미지 작업/ })).toHaveLength(
    2,
  );
});
it("swaps send for stop while a turn runs and the input is empty", async () => {
  setup(DEFAULT_MODELS, {
    readChat: async () => ({
      version: 1,
      id: "00000000-0000-4000-a000-000000000001",
      title: "대화",
      runtime: "codex",
      nativeThreadId: null,
      model: null,
      effort: null,
      state: "running",
      createdAt: 1,
      updatedAt: 1,
      items: [],
      checkpoint: [],
      question: null,
    }),
  });
  render(<ChatPanel enabled context={context} />);
  const input = await screen.findByRole("textbox", { name: "메시지" });
  expect(await screen.findByRole("button", { name: "중지" })).toBeTruthy();
  fireEvent.change(input, { target: { value: "글꼴도 맞춰줘" } });
  expect(screen.queryByRole("button", { name: "중지" })).toBeNull();
  expect(screen.getByRole("button", { name: "추가 지시" })).toBeTruthy();
});
it("renders conversation controls in the host header and requests undo from a tool row", async () => {
  const loaded = (): ChatSession => ({
    ...f.session,
    nativeThreadId: "native",
    items: [
      {
        id: "t1",
        role: "tool",
        state: "completed",
        createdAt: 1,
        text: "{}",
        toolName: "carrot_apply_translation_batch",
      },
    ],
  });
  const compactChat = vi.fn<ChatApi["compactChat"]>(async () => ({
    ...loaded(),
    state: "idle",
    updatedAt: 5,
  }));
  const createChat = vi.fn<ChatApi["createChat"]>();
  const f = setup(DEFAULT_MODELS, {
    compactChat,
    createChat,
    readChat: async () => loaded(),
  });
  const slot = document.body.appendChild(document.createElement("div"));
  render(<ChatPanel enabled context={context} headerSlot={slot} />);
  const compact = await screen.findByRole("button", { name: "대화 압축" });
  expect(slot.contains(compact)).toBe(true);
  await waitFor(() => expect(compact.hasAttribute("disabled")).toBe(false));
  fireEvent.click(compact);
  await waitFor(() => expect(compactChat).toHaveBeenCalledOnce());

  chooseRuntime("Codex");
  expect(createChat).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /페이지 편집/ }));
  fireEvent.click(screen.getByRole("button", { name: "되돌리기 확인" }));
  await waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  expect(f.send.mock.calls[0][0].text).toContain(
    "carrot_apply_translation_batch",
  );
  slot.remove();
});
