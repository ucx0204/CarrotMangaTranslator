// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { NotificationPort } from "../src/renderer/src/lib/notificationPort";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import type { AppSettings } from "../src/shared/settingsTypes";
import { SETTINGS_SECRET_PRESERVE_SENTINEL } from "../src/shared/settingsSecrets";
import type {
  ChapterStoryMemory,
  ResetWorkContextResult,
  WorkStyleGuide,
} from "../src/shared/workContextTypes";
import type { WorkContextUsage } from "../src/shared/workContextUsageTypes";
import { createWorkContextResearchFingerprint } from "../src/shared/workContextResearchProposal";
import type { WorkContextResearchProposal } from "../src/shared/workContextResearchTypes";

const gatewayMocks = {
  analyzeWorkContext: vi.fn(),
  cancelWorkContextResearch: vi.fn(),
  getChapterStoryMemory: vi.fn(),
  getCodexAccount: vi.fn(),
  getSettings: vi.fn(),
  getTavilyUsage: vi.fn(),
  getWorkContextUsage: vi.fn(),
  getWorkResearchTitle: vi.fn(),
  getWorkStyleGuide: vi.fn(),
  loginCodexAccount: vi.fn(),
  logoutCodexAccount: vi.fn(),
  onJobEvent: vi.fn(() => () => undefined),
  openResearchSource: vi.fn(),
  resetWorkContext: vi.fn(),
  researchWorkContext: vi.fn(),
  saveChapterStoryMemory: vi.fn(),
  saveSettings: vi.fn(),
  saveWorkResearchTitle: vi.fn(),
  saveWorkStyleGuide: vi.fn(),
};

const notificationMocks: NotificationPort = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
};

import { StyleGuideModal } from "../src/renderer/src/components/StyleGuideModal";
import { workContextIpcContracts } from "../src/shared/ipcContracts";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const TS = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  window.mangaApi = createTestMangaGatewayStub(gatewayMocks);
  gatewayMocks.getWorkStyleGuide.mockResolvedValue(makeGuide());
  gatewayMocks.getChapterStoryMemory.mockResolvedValue(makeMemory());
  gatewayMocks.getWorkResearchTitle.mockResolvedValue(null);
  gatewayMocks.getWorkContextUsage.mockResolvedValue(makeUsage(7));
  gatewayMocks.getSettings.mockResolvedValue(makeSettings());
  gatewayMocks.getTavilyUsage.mockResolvedValue(makeTavilyUsage());
  gatewayMocks.getCodexAccount.mockResolvedValue(makeCodexAccount(false));
  gatewayMocks.loginCodexAccount.mockResolvedValue(makeCodexAccount(true));
  gatewayMocks.logoutCodexAccount.mockResolvedValue(makeCodexAccount(false));
  gatewayMocks.openResearchSource.mockResolvedValue({
    opened: true,
    url: "https://www.tavily.com/",
  });
  gatewayMocks.resetWorkContext.mockResolvedValue(makeResetResult());
  gatewayMocks.cancelWorkContextResearch.mockResolvedValue({ cancelled: true });
  gatewayMocks.saveWorkStyleGuide.mockImplementation(async (guide) => guide);
  gatewayMocks.saveChapterStoryMemory.mockImplementation(
    async (memory) => memory,
  );
  gatewayMocks.saveSettings.mockImplementation(async (settings) => settings);
  gatewayMocks.saveWorkResearchTitle.mockImplementation(async (request) => ({
    schemaVersion: 1,
    ...request,
    updatedAt: TS,
  }));
});

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
  vi.restoreAllMocks();
});

describe("StyleGuideModal complete reset", () => {
  it("orders reset, cancel, and save like the other modal footers", async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await screen.findByDisplayValue("魔王");
    const footer = document.querySelector<HTMLElement>(".style-guide-footer");
    if (!footer) throw new Error("Style guide footer was not rendered.");

    expect(
      within(footer)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["용어·기억 전체 초기화", "취소", "저장"]);
    fireEvent.click(within(footer).getByRole("button", { name: "취소" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps glossary keyboard editing alive after delete, cancel, save, and re-add", async () => {
    renderModal();
    await screen.findByDisplayValue("魔王");

    fireEvent.click(screen.getByRole("button", { name: "魔王 삭제" }));
    const addRow = screen.getByRole("button", { name: "행 추가" });
    fireEvent.click(addRow);
    fireEvent.click(screen.getByRole("button", { name: "새 행 입력 취소" }));
    fireEvent.click(addRow);

    let draftRow = document.querySelector(".style-guide-row.is-draft");
    expect(draftRow).not.toBeNull();
    let source = within(draftRow as HTMLElement).getByPlaceholderText("원문");
    const translation = within(draftRow as HTMLElement).getByPlaceholderText(
      "번역",
    );
    fireEvent.change(source, { target: { value: "再登録" } });
    fireEvent.change(translation, { target: { value: "재등록" } });
    expect(source).toHaveProperty("value", "再登録");
    expect(translation).toHaveProperty("value", "재등록");

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => {
      expect(gatewayMocks.saveWorkStyleGuide).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("button", { name: "새 행 입력 완료" }));
    fireEvent.click(addRow);
    draftRow = document.querySelector(".style-guide-row.is-draft");
    expect(draftRow).not.toBeNull();
    source = within(draftRow as HTMLElement).getByPlaceholderText("원문");
    fireEvent.change(source, { target: { value: "追加入力" } });
    expect(source).toHaveProperty("value", "追加入力");
    expect(document.activeElement).toBe(source);
  });

  it("can re-add immediately after saving removes an empty draft", async () => {
    renderModal();
    await screen.findByDisplayValue("魔王");
    const addRow = screen.getByRole("button", { name: "행 추가" });

    fireEvent.click(addRow);
    expect(document.querySelector(".style-guide-row.is-draft")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => {
      expect(document.querySelector(".style-guide-row.is-draft")).toBeNull();
    });

    fireEvent.click(addRow);
    const replacement = document.querySelector(".style-guide-row.is-draft");
    expect(replacement).not.toBeNull();
    const source = within(replacement as HTMLElement).getByPlaceholderText(
      "원문",
    );
    fireEvent.change(source, { target: { value: "保存後" } });
    expect(source).toHaveProperty("value", "保存後");
    expect(document.activeElement).toBe(source);
  });

  it("does not call reset when the destructive confirmation is cancelled", async () => {
    renderModal();
    await screen.findByDisplayValue("魔王");

    fireEvent.click(resetButton());
    const confirmation = await screen.findByRole("dialog", {
      name: /용어·기억 전체 초기화/,
    });

    expect(
      within(confirmation).getByText(/모든 화의 스토리 메모리/),
    ).toBeTruthy();
    fireEvent.click(within(confirmation).getByRole("button", { name: "취소" }));
    expect(gatewayMocks.resetWorkContext).not.toHaveBeenCalled();
  });

  it("calls the reset contract after confirmation and applies its empty result", async () => {
    renderModal();
    await screen.findByDisplayValue("魔王");

    fireEvent.click(resetButton());
    fireEvent.click(
      within(
        await screen.findByRole("dialog", {
          name: /용어·기억 전체 초기화/,
        }),
      ).getByRole("button", { name: "확인" }),
    );

    await waitFor(() => {
      expect(gatewayMocks.resetWorkContext).toHaveBeenCalledWith({
        chapterId: CHAPTER_ID,
      });
    });
    await waitFor(() => {
      expect(screen.queryByDisplayValue("魔王")).toBeNull();
    });
    expect(gatewayMocks.getWorkContextUsage).toHaveBeenCalledTimes(2);
    expect(notificationMocks.success).toHaveBeenCalledWith(
      "용어/기억을 초기화하고 2화의 스토리 메모리를 비웠습니다.",
    );
  });

  it("reports reset failure and restores the reset action", async () => {
    gatewayMocks.resetWorkContext.mockRejectedValueOnce(
      new Error("reset failed"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderModal();
    await screen.findByDisplayValue("魔王");

    fireEvent.click(resetButton());
    fireEvent.click(
      within(
        await screen.findByRole("dialog", {
          name: /용어·기억 전체 초기화/,
        }),
      ).getByRole("button", { name: "확인" }),
    );

    await waitFor(() => {
      expect(notificationMocks.error).toHaveBeenCalledWith(
        "용어/기억 전체 초기화에 실패했습니다.",
      );
    });
    expect(screen.getByDisplayValue("魔王")).toBeTruthy();
    expect(resetButton().disabled).toBe(false);
  });

  it("keeps the reset action disabled while another app job is active", async () => {
    renderModal({ jobActive: true });
    await screen.findByDisplayValue("魔王");

    expect(resetButton().disabled).toBe(true);
    fireEvent.click(resetButton());

    expect(screen.queryByRole("button", { name: "확인" })).toBeNull();
    expect(gatewayMocks.resetWorkContext).not.toHaveBeenCalled();
  });

  it("confirms and remembers the research title before creating a preview", async () => {
    const guide = makeGuide();
    gatewayMocks.getWorkStyleGuide.mockResolvedValueOnce(guide);
    gatewayMocks.researchWorkContext.mockResolvedValueOnce(
      makeResearchProposal(guide),
    );
    renderModal();
    await screen.findByDisplayValue("魔王");

    fireEvent.click(screen.getByRole("button", { name: "용어집 조사" }));
    const setupDialog = await screen.findByRole("dialog", {
      name: "용어집 조사 준비",
    });
    expect(gatewayMocks.researchWorkContext).not.toHaveBeenCalled();
    const titleInput = within(setupDialog).getByLabelText("조사할 작품 이름");
    expect(titleInput).toHaveProperty("value", "테스트 작품");
    fireEvent.change(titleInput, {
      target: { value: "수정한 조사 작품명" },
    });
    fireEvent.click(
      within(setupDialog).getByRole("button", {
        name: "이 제목으로 조사",
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "조사 변경안 검토" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    expect(gatewayMocks.saveWorkStyleGuide).not.toHaveBeenCalled();
    expect(gatewayMocks.researchWorkContext).toHaveBeenCalledWith(
      expect.objectContaining({
        chapterId: CHAPTER_ID,
        researchTitle: "수정한 조사 작품명",
        engine: "tavily",
        guideSnapshot: guide,
      }),
    );
    expect(gatewayMocks.saveWorkResearchTitle).toHaveBeenCalledWith({
      workId: WORK_ID,
      researchTitle: "수정한 조사 작품명",
    });
    expect(gatewayMocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        internetResearch: expect.objectContaining({
          tavilyApiKey: SETTINGS_SECRET_PRESERVE_SENTINEL,
          tavilyMaxCreditsPerRun: 10,
        }),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "선택 1개 적용" }));
    expect(await screen.findByDisplayValue("開錠（アンロック）")).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "조사 변경안 검토" }),
    ).toBeNull();
    expect(gatewayMocks.saveWorkStyleGuide).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "용어집 조사" }));
    expect(
      within(
        await screen.findByRole("dialog", { name: "용어집 조사 준비" }),
      ).getByLabelText("조사할 작품 이름"),
    ).toHaveProperty("value", "수정한 조사 작품명");
  });

  it("moves live research out of the modal and returns only for result review", async () => {
    const guide = makeGuide();
    const pending = createDeferred<WorkContextResearchProposal>();
    const onBackgroundStateChange = vi.fn();
    gatewayMocks.getWorkStyleGuide.mockResolvedValueOnce(guide);
    gatewayMocks.researchWorkContext.mockReturnValueOnce(pending.promise);
    renderModal({ onBackgroundStateChange });
    await screen.findByDisplayValue("魔王");

    fireEvent.click(screen.getByRole("button", { name: "용어집 조사" }));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "용어집 조사 준비" }),
      ).getByRole("button", { name: "이 제목으로 조사" }),
    );
    await waitFor(() =>
      expect(gatewayMocks.researchWorkContext).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(onBackgroundStateChange).toHaveBeenLastCalledWith(true),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("테스트 작품 등장인물 공식")).toBeNull();
    expect(gatewayMocks.cancelWorkContextResearch).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(makeResearchProposal(guide));
      await pending.promise;
    });
    expect(
      await screen.findByRole("dialog", { name: "조사 변경안 검토" }),
    ).toBeTruthy();
  });

  it("closes the nested research review without changing the draft", async () => {
    const guide = makeGuide();
    gatewayMocks.getWorkStyleGuide.mockResolvedValueOnce(guide);
    gatewayMocks.researchWorkContext.mockResolvedValueOnce(
      makeResearchProposal(guide),
    );
    renderModal();
    await screen.findByDisplayValue("魔王");

    fireEvent.click(screen.getByRole("button", { name: "용어집 조사" }));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "용어집 조사 준비" }),
      ).getByRole("button", { name: "이 제목으로 조사" }),
    );
    const reviewDialog = await screen.findByRole("dialog", {
      name: "조사 변경안 검토",
    });
    fireEvent.click(within(reviewDialog).getByRole("button", { name: "취소" }));

    expect(
      screen.queryByRole("dialog", { name: "조사 변경안 검토" }),
    ).toBeNull();
    expect(screen.getByDisplayValue("魔王")).toBeTruthy();
    expect(screen.queryByDisplayValue("開錠（アンロック）")).toBeNull();
    expect(gatewayMocks.saveWorkStyleGuide).not.toHaveBeenCalled();
  });

  it("keeps a cancelled research setup out of settings and research", async () => {
    renderModal();
    await screen.findByDisplayValue("魔王");

    fireEvent.click(screen.getByRole("button", { name: "용어집 조사" }));
    const setupDialog = await screen.findByRole("dialog", {
      name: "용어집 조사 준비",
    });
    expect(within(setupDialog).getByLabelText("Tavily API 키")).toBeTruthy();
    expect(
      within(setupDialog).getByLabelText("조사당 최대 크레딧"),
    ).toHaveProperty("value", "10");
    fireEvent.click(within(setupDialog).getByRole("button", { name: "취소" }));

    expect(gatewayMocks.saveSettings).not.toHaveBeenCalled();
    expect(gatewayMocks.saveWorkResearchTitle).not.toHaveBeenCalled();
    expect(gatewayMocks.researchWorkContext).not.toHaveBeenCalled();
  });

  it("shows Tavily setup without a key and persists a replacement key and credit limit", async () => {
    const settings = makeSettings();
    settings.internetResearch.tavilyApiKey = undefined;
    gatewayMocks.researchWorkContext.mockResolvedValueOnce(
      makeResearchProposal(makeGuide()),
    );
    renderModal({ settings });
    await screen.findByDisplayValue("魔王");

    fireEvent.click(screen.getByRole("button", { name: "용어집 조사" }));
    const setupDialog = await screen.findByRole("dialog", {
      name: "용어집 조사 준비",
    });
    const keyInput = within(setupDialog).getByLabelText("Tavily API 키");
    expect(keyInput).toHaveProperty("value", "");
    fireEvent.click(
      within(setupDialog).getByRole("button", {
        name: "Tavily에서 API 키 발급",
      }),
    );
    expect(gatewayMocks.openResearchSource).toHaveBeenCalledWith(
      "https://www.tavily.com/",
    );

    fireEvent.change(keyInput, { target: { value: "tvly-new-key" } });
    fireEvent.change(within(setupDialog).getByLabelText("조사당 최대 크레딧"), {
      target: { value: "20" },
    });
    fireEvent.click(
      within(setupDialog).getByRole("button", {
        name: "이 제목으로 조사",
      }),
    );

    await waitFor(() =>
      expect(gatewayMocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          internetResearch: expect.objectContaining({
            tavilyApiKey: "tvly-new-key",
            tavilyMaxCreditsPerRun: 20,
          }),
        }),
      ),
    );
    expect(gatewayMocks.getTavilyUsage).toHaveBeenCalledWith({
      apiKey: "tvly-new-key",
      force: true,
    });
  });

  it("checks Codex on open and offers ChatGPT login before research", async () => {
    gatewayMocks.researchWorkContext.mockResolvedValueOnce(
      makeResearchProposal(makeGuide()),
    );
    renderModal();
    await screen.findByDisplayValue("魔王");

    fireEvent.click(screen.getByRole("radio", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "용어집 조사" }));
    const setupDialog = await screen.findByRole("dialog", {
      name: "용어집 조사 준비",
    });
    await waitFor(() =>
      expect(gatewayMocks.getCodexAccount).toHaveBeenCalled(),
    );
    expect(within(setupDialog).getByText("로그인되지 않음")).toBeTruthy();
    expect(
      (
        within(setupDialog).getByRole("button", {
          name: "이 제목으로 조사",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.click(
      within(setupDialog).getByRole("button", { name: "ChatGPT로 로그인" }),
    );
    await waitFor(() =>
      expect(gatewayMocks.loginCodexAccount).toHaveBeenCalledOnce(),
    );
    fireEvent.click(
      within(setupDialog).getByRole("button", {
        name: "이 제목으로 조사",
      }),
    );
    await waitFor(() =>
      expect(gatewayMocks.researchWorkContext).toHaveBeenCalledWith(
        expect.objectContaining({
          engine: "codex-web",
          researchTitle: "테스트 작품",
        }),
      ),
    );
    expect(gatewayMocks.saveSettings).not.toHaveBeenCalled();
  });

  it("ignores an older usage response that finishes after reset refresh", async () => {
    const initialUsage = createDeferred<WorkContextUsage>();
    const refreshedUsage = createDeferred<WorkContextUsage>();
    gatewayMocks.getWorkContextUsage
      .mockReturnValueOnce(initialUsage.promise)
      .mockReturnValueOnce(refreshedUsage.promise);
    gatewayMocks.resetWorkContext.mockResolvedValue({
      ...makeResetResult(),
      // Keep one entry visible so the usage metric remains observable.
      styleGuide: makeGuide(),
    });
    renderModal();
    const sourceInput = await screen.findByDisplayValue("魔王");

    fireEvent.click(resetButton());
    fireEvent.click(
      within(
        await screen.findByRole("dialog", {
          name: /용어·기억 전체 초기화/,
        }),
      ).getByRole("button", { name: "확인" }),
    );
    await waitFor(() => {
      expect(gatewayMocks.getWorkContextUsage).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      refreshedUsage.resolve(makeUsage(1));
      await refreshedUsage.promise;
    });
    expect(usageRow(sourceInput).textContent).toContain("1");

    await act(async () => {
      initialUsage.resolve(makeUsage(9));
      await initialUsage.promise;
    });
    expect(usageRow(sourceInput).textContent).toContain("1");
    expect(within(usageRow(sourceInput)).queryByText("9")).toBeNull();
  });
});

describe("reset work-context IPC contract", () => {
  it("keeps the reset channel, strict request, and result schema explicit", () => {
    const contract = workContextIpcContracts.resetWorkContext;

    expect(contract.apiKey).toBe("resetWorkContext");
    expect(contract.channel).toBe("context:reset-work-context");
    expect(contract.args.parse([{ chapterId: CHAPTER_ID }])).toEqual([
      { chapterId: CHAPTER_ID },
    ]);
    expect(
      contract.args.safeParse([
        { chapterId: CHAPTER_ID, unexpected: "not-allowed" },
      ]).success,
    ).toBe(false);
    expect(contract.result.parse(makeResetResult())).toEqual(makeResetResult());
    expect(
      contract.result.safeParse({
        ...makeResetResult(),
        resetChapterCount: -1,
      }).success,
    ).toBe(false);
  });
});

function renderModal({
  jobActive = false,
  onClose = vi.fn(),
  onBackgroundStateChange,
  settings = makeSettings(),
}: {
  jobActive?: boolean;
  onClose?: () => void;
  onBackgroundStateChange?: (backgrounded: boolean) => void;
  settings?: AppSettings;
} = {}): void {
  render(
    <StyleGuideModal
      chapter={makeChapter()}
      workTitle="테스트 작품"
      jobActive={jobActive}
      notificationPort={notificationMocks}
      settings={settings}
      onBackgroundStateChange={onBackgroundStateChange}
      onSaveSettings={gatewayMocks.saveSettings}
      onClose={onClose}
    />,
  );
}

function makeSettings(): AppSettings {
  return {
    modelProvider: "gemma",
    translation: { sourceLanguage: "ja", targetLanguage: "ko" },
    gemma: {
      modelSource: "huggingface",
      modelRepo: "test/model",
      modelFile: "test.gguf",
      vramMode: "minimum12b",
    },
    codex: { model: "gpt-test", reasoningEffort: "medium" },
    internetResearch: {
      tavilyAnalysisProvider: "gemma",
      gemmaPreset: "minimum12b",
      gemmaReasoningEffort: "medium",
      gemmaMaxOutputTokens: 32_768,
      gemmaContextTokens: 65_536,
      apiModel: "gpt-test",
      apiMaxOutputTokens: 32_768,
      apiContextTokens: 65_536,
      codexModel: "gpt-test",
      codexReasoningEffort: "medium",
      codexMaxOutputTokens: 32_768,
      codexContextTokens: 256 * 1_024,
      tavilyApiKey: SETTINGS_SECRET_PRESERVE_SENTINEL,
      tavilyMaxCreditsPerRun: 10,
    },
    api: { baseUrl: "https://example.test/v1", model: "gpt-test" },
    ocr: { device: "cpu", qualityMode: "economy" },
    maxTokens: 32_768,
    ctx: 65_536,
  };
}

function makeTavilyUsage() {
  return {
    configured: true,
    key: {
      used: 120,
      limit: 1_000,
      remaining: 880,
      searchUsed: 120,
    },
    account: {
      plan: "Researcher",
      used: 120,
      limit: 1_000,
      remaining: 880,
      paygoUsed: 0,
      paygoLimit: 0,
    },
    fetchedAt: TS,
  };
}

function makeCodexAccount(authenticated: boolean) {
  return {
    authenticated,
    accountKind: authenticated ? ("chatgpt" as const) : null,
    email: authenticated ? "reader@example.test" : null,
    planType: authenticated ? "plus" : null,
    requiresOpenaiAuth: true,
    appServerVersion: "0.150.1",
    models: authenticated
      ? [
          {
            id: "gpt-test",
            displayName: "GPT Test",
            supportedReasoningEfforts: ["medium" as const],
            defaultReasoningEffort: "medium" as const,
            isDefault: true,
          },
        ]
      : [],
  };
}

function resetButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "용어·기억 전체 초기화",
  }) as HTMLButtonElement;
}

function usageRow(sourceInput: HTMLElement): HTMLElement {
  const row = sourceInput.closest(".style-guide-row");
  if (!row) throw new Error("Glossary row was not rendered.");
  return row as HTMLElement;
}

function makeChapter(): ChapterSnapshot {
  return {
    id: CHAPTER_ID,
    workId: WORK_ID,
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pageOrder: [PAGE_ID],
    pages: [
      {
        id: PAGE_ID,
        name: "001.png",
        imagePath: "C:/library/001.png",
        dataUrl: "",
        width: 100,
        height: 150,
        blocks: [],
        analysisStatus: "completed",
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeGuide(): WorkStyleGuide {
  return {
    schemaVersion: 1,
    workId: WORK_ID,
    glossary: [
      {
        id: "term-1",
        source: "魔王",
        target: "마왕",
        category: "term",
        enabled: true,
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    characters: [],
    rules: {
      honorifics: "preserve",
      sfxMode: "note",
      defaultTone: "literal",
    },
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeResearchProposal(
  guide: WorkStyleGuide,
): WorkContextResearchProposal {
  return {
    engine: "codex-web",
    baseFingerprint: createWorkContextResearchFingerprint(guide),
    operations: [
      {
        id: "research-add-unlock",
        entity: "glossary",
        action: "add",
        reason: "공식 표기 확인",
        confidence: "high",
        selectedByDefault: true,
        evidence: { pageCount: 1, mentionCount: 1 },
        sources: [
          { title: "공식 작품 페이지", url: "https://example.test/work" },
        ],
        after: {
          id: "unlock",
          source: "開錠（アンロック）",
          target: "개정(언록)",
          category: "term",
          origin: "ai",
          enabled: true,
          createdAt: TS,
          updatedAt: TS,
        },
      },
    ],
    warnings: [],
    stats: {
      queryCount: 1,
      sourceCount: 1,
      tavilyCreditsUsed: 0,
      estimatedTokenDelta: 12,
      elapsedMs: 100,
    },
  };
}

function makeMemory(): ChapterStoryMemory {
  return {
    schemaVersion: 1,
    workId: WORK_ID,
    chapterId: CHAPTER_ID,
    pages: [
      {
        pageId: PAGE_ID,
        pageName: "001.png",
        pageIndex: 0,
        sourceDigest: "魔王",
        translatedDigest: "마왕",
        summary: "마왕이 등장한다.",
        updatedAt: TS,
      },
    ],
    updatedAt: TS,
    aiAnalyzedAt: TS,
  };
}

function makeResetResult(): ResetWorkContextResult {
  return {
    styleGuide: {
      ...makeGuide(),
      glossary: [],
      characters: [],
    },
    storyMemory: {
      ...makeMemory(),
      pages: [],
      aiAnalyzedAt: undefined,
    },
    resetChapterCount: 2,
  };
}

function makeUsage(mentionCount: number): WorkContextUsage {
  return {
    workId: WORK_ID,
    glossary: [{ id: "term-1", pageCount: 1, mentionCount }],
    characters: [],
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
