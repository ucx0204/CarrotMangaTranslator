/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import exampleSettings from "../settings.example.json";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { SettingsModal } from "../src/renderer/src/components/SettingsModal";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import type { SettingsOpenRequest } from "../src/renderer/src/hooks/useSettingsDialog";
import {
  DEFAULT_BLOCK_FONT_CATALOG,
  getBaseBlockFontOptions,
  getBlockFontOptions,
} from "../src/renderer/src/lib/fonts";
import type { CodexAccountSnapshot } from "../src/shared/codexAccountTypes";
import {
  GEMMA_26B_MMPROJ_FILE,
  GEMMA_26B_MMPROJ_REPO,
  GEMMA_26B_MODEL_FILE_IQ3_S,
  GEMMA_26B_MODEL_REPO,
  GEMMA_26B_QAT_MMPROJ_FILE,
  GEMMA_26B_QAT_MMPROJ_REPO,
  GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_26B_QAT_MODEL_REPO,
} from "../src/shared/modelPresets";
import type { AppSettings } from "../src/shared/settingsTypes";
import { chooseCustomSelectOption } from "./testUtils/customSelect";

const initialSettings = structuredClone(exampleSettings) as AppSettings;

beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({
    getCodexAccount: vi.fn(async () => ({
      authenticated: false,
      accountKind: null,
      email: null,
      planType: null,
      requiresOpenaiAuth: true,
      appServerVersion: "0.150.1",
      models: [],
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "mangaApi");
});

describe("settings draft safety", () => {
  it("opens the requested preset manager and returns to general settings", () => {
    renderSettings({
      openRequest: { revision: 1, target: "style-presets" },
    });

    expect(screen.getByRole("tab", { name: "기본 서식" })).toHaveProperty(
      "ariaSelected",
      "true",
    );
    expect(screen.getByRole("button", { name: "편집 화면으로" })).toBeTruthy();

    cleanup();
    renderSettings({ openRequest: { revision: 2, target: "general" } });
    expect(screen.getByRole("tab", { name: "일반" })).toHaveProperty(
      "ariaSelected",
      "true",
    );
  });

  it("nests translation and internet research inside the single LLM section", () => {
    renderSettings();

    const settingsTabs = screen.getByRole("tablist", { name: "설정 영역" });
    expect(
      within(settingsTabs).queryByRole("tab", { name: "인터넷 조사" }),
    ).toBeNull();

    fireEvent.click(within(settingsTabs).getByRole("tab", { name: "LLM" }));
    const llmTabs = screen.getByRole("tablist", { name: "LLM 설정" });
    expect(within(llmTabs).getAllByRole("tab")).toHaveLength(2);
    expect(within(llmTabs).getByRole("tab", { name: "번역" })).toHaveProperty(
      "ariaSelected",
      "true",
    );

    fireEvent.click(within(llmTabs).getByRole("tab", { name: "인터넷 조사" }));
    expect(screen.getByRole("heading", { name: "Tavily" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Codex" })).toBeTruthy();
    expect(screen.queryByText("조사 방식")).toBeNull();
    expect(
      within(llmTabs).getByRole("tab", { name: "인터넷 조사" }),
    ).toHaveProperty("ariaSelected", "true");
    expect(screen.queryByRole("heading", { name: "번역 엔진" })).toBeNull();
  });

  it("disables Save until the draft changes and protects dirty close", () => {
    const onCancel = vi.fn();
    renderSettings({ onCancel });

    const save = screen.getByRole("button", { name: "저장" });
    expect(save).toHaveProperty("disabled", true);

    chooseCustomSelectOption("앱 언어", "English");
    expect(save).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onCancel).not.toHaveBeenCalled();
    const confirmDialog = screen.getAllByRole("dialog").at(-1);
    if (!confirmDialog) throw new Error("discard confirmation not found");
    expect(
      within(confirmDialog).getByText("변경한 설정을 버리고 닫을까요?"),
    ).toBeTruthy();
    fireEvent.click(
      within(confirmDialog).getByRole("button", {
        name: "변경 사항 버리기",
      }),
    );
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps conflicting settings controls disabled while an external save is active", () => {
    renderSettings({ busy: true });

    expect(screen.getByRole("button", { name: "기본값 복원" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "저장" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("loads defaults into the draft without applying them until Save", async () => {
    const onSubmit = vi.fn();
    const defaultSettings = {
      ...structuredClone(initialSettings),
      ui: { ...initialSettings.ui, locale: "en" as const },
    };
    const onReset = vi.fn(() => Promise.resolve(defaultSettings));
    renderSettings({ onReset, onSubmit });

    fireEvent.click(screen.getByRole("button", { name: "기본값 복원" }));

    expect(onReset).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      await screen.findByText("기본값을 임시로 불러왔습니다"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "앱 언어" })).toHaveProperty(
        "value",
        "en",
      ),
    );

    const save = screen.getByRole("button", { name: "저장" });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        ui: expect.objectContaining({ locale: "en" }),
      }),
    );
  });

  it("leaves the draft unchanged when loading defaults is cancelled", async () => {
    const onReset = vi.fn(async () => null);
    renderSettings({ onReset });

    fireEvent.click(screen.getByRole("button", { name: "기본값 복원" }));

    await waitFor(() => expect(onReset).toHaveBeenCalledOnce());
    expect(screen.queryByText("기본값을 임시로 불러왔습니다")).toBeNull();
    expect(screen.getByRole("button", { name: "저장" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("keeps log access and offers the shareable error report", () => {
    const onOpenLogFolder = vi.fn();
    const onOpenErrorReport = vi.fn();
    renderSettings({ onOpenErrorReport, onOpenLogFolder });

    fireEvent.click(screen.getByRole("button", { name: "로그 폴더 열기" }));
    expect(onOpenLogFolder).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "오류 보고" }));
    expect(onOpenErrorReport).toHaveBeenCalledOnce();
  });

  it("separates speed and legacy models while preserving existing tuning", async () => {
    const onSubmit = vi.fn();
    const qatSettings = structuredClone(initialSettings);
    qatSettings.gemma = {
      ...qatSettings.gemma,
      modelSource: "huggingface",
      modelRepo: GEMMA_26B_QAT_MODEL_REPO,
      modelFile: GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
      mmprojRepo: GEMMA_26B_QAT_MMPROJ_REPO,
      mmprojFile: GEMMA_26B_QAT_MMPROJ_FILE,
      vramMode: "economy26b",
      fitTargetMb: 512,
    };
    renderSettings({ onSubmit, settings: qatSettings });

    fireEvent.click(screen.getByRole("tab", { name: "LLM" }));
    const familyGroup = screen.getByRole("group", { name: "모델 계열" });
    const presetGroup = screen.getByRole("group", { name: "모델 프리셋" });

    expect(
      within(familyGroup).getByRole("button", { name: "속도(추천)" }),
    ).toHaveProperty("ariaPressed", "true");
    expect(within(presetGroup).getAllByRole("button")).toHaveLength(4);
    expect(
      within(presetGroup).getByRole("button", { name: "26B (16GB)" }),
    ).toHaveProperty("ariaPressed", "true");

    fireEvent.click(
      within(familyGroup).getByRole("button", { name: "레거시" }),
    );
    expect(
      within(familyGroup).getByRole("button", { name: "레거시" }),
    ).toHaveProperty("ariaPressed", "true");
    expect(
      within(presetGroup).getByRole("button", { name: "26B (16GB)" }),
    ).toHaveProperty("ariaPressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        gemma: expect.objectContaining({
          modelRepo: GEMMA_26B_MODEL_REPO,
          modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
          mmprojRepo: GEMMA_26B_MMPROJ_REPO,
          mmprojFile: GEMMA_26B_MMPROJ_FILE,
          fitTargetMb: 512,
        }),
      }),
    );
  });

  it("shows a 24 GB GPU default as the speed-family 26B preset", () => {
    const settings = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24564,
        rtxGeneration: 40,
        computeCapability: 8.9,
        vendor: "nvidia",
      },
    );
    renderSettings({ settings });

    fireEvent.click(screen.getByRole("tab", { name: "LLM" }));
    const familyGroup = screen.getByRole("group", { name: "모델 계열" });
    const presetGroup = screen.getByRole("group", { name: "모델 프리셋" });

    expect(
      within(familyGroup).getByRole("button", { name: "속도(추천)" }),
    ).toHaveProperty("ariaPressed", "true");
    expect(
      within(presetGroup).getByRole("button", { name: "26B (16GB)" }),
    ).toHaveProperty("ariaPressed", "true");
  });

  it("warns when the selected model needs more VRAM than the detected GPU", () => {
    const settings = structuredClone(initialSettings);
    settings.runtimeHardware = {
      gpuVendor: "nvidia",
      gpuMemoryMb: 8 * 1024,
    };
    renderSettings({ settings });

    fireEvent.click(screen.getByRole("tab", { name: "LLM" }));
    const presetGroup = screen.getByRole("group", { name: "모델 프리셋" });
    fireEvent.click(
      within(presetGroup).getByRole("button", { name: "26B (16GB)" }),
    );

    expect(screen.getByText("선택한 모델에 VRAM이 부족합니다.")).toBeTruthy();
    expect(
      screen.getByText(/감지된 VRAM은 8 GB이고 이 모델은 16 GB급 GPU용입니다/),
    ).toBeTruthy();

    fireEvent.click(
      within(presetGroup).getByRole("button", { name: "12B (8GB)" }),
    );
    expect(screen.queryByText("선택한 모델에 VRAM이 부족합니다.")).toBeNull();
  });

  it("accepts arbitrary MiB reserve input and additive quick buttons", async () => {
    const onSubmit = vi.fn();
    const settings = structuredClone(initialSettings);
    settings.gemma = { ...settings.gemma, fitTargetMb: 777 };
    renderSettings({ onSubmit, settings });

    fireEvent.click(screen.getByRole("tab", { name: "LLM" }));
    const input = screen.getByRole("spinbutton", {
      name: "여유 VRAM (MiB)",
    });
    expect(input).toHaveProperty("value", "777");

    fireEvent.click(
      screen.getByRole("button", { name: "여유 VRAM에 128 MiB 추가" }),
    );
    expect(input).toHaveProperty("value", "905");
    fireEvent.click(
      screen.getByRole("button", { name: "여유 VRAM에 256 MiB 추가" }),
    );
    expect(input).toHaveProperty("value", "1161");

    fireEvent.change(input, { target: { value: "1235" } });
    expect(input).toHaveProperty("value", "1235");
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        gemma: expect.objectContaining({ fitTargetMb: 1235 }),
      }),
    );
  });

  it("reveals Codex catalog controls and generation limits only after login", async () => {
    const models = [
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "low",
        isDefault: true,
      },
    ] satisfies CodexAccountSnapshot["models"];
    const signedOut = {
      authenticated: false,
      accountKind: null,
      email: null,
      planType: null,
      requiresOpenaiAuth: true,
      appServerVersion: "0.150.1",
      models: [],
    } satisfies CodexAccountSnapshot;
    const signedIn = {
      ...signedOut,
      authenticated: true,
      accountKind: "chatgpt",
      email: "reader@example.com",
      planType: "plus",
      models,
    } satisfies CodexAccountSnapshot;
    window.mangaApi = createTestMangaGatewayStub({
      getCodexAccount: vi.fn(async () => signedOut),
      loginCodexAccount: vi.fn(async () => signedIn),
      logoutCodexAccount: vi.fn(async () => signedOut),
    });
    const settings: AppSettings = {
      ...structuredClone(initialSettings),
      modelProvider: "openai-codex",
      codex: { model: "gpt-5.6-sol", reasoningEffort: "low" },
      maxTokens: 32768,
      ctx: 65536,
    };
    renderSettings({ settings });
    fireEvent.click(screen.getByRole("tab", { name: "LLM" }));

    await screen.findByText("로그인되지 않음");
    expect(screen.queryByRole("combobox", { name: "Codex 모델" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "생성 한도" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "ChatGPT로 로그인" }));

    await screen.findByRole("combobox", { name: "Codex 모델" });
    expect(screen.getByRole("combobox", { name: /추론 강도/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "생성 한도" })).toBeTruthy();
  });
});

function renderSettings({
  busy = false,
  openRequest,
  onCancel = vi.fn(),
  onOpenErrorReport = vi.fn(),
  onOpenLogFolder = vi.fn(),
  onReset = vi.fn(() => Promise.resolve(initialSettings)),
  onSubmit = vi.fn(),
  settings = initialSettings,
}: {
  busy?: boolean;
  openRequest?: SettingsOpenRequest;
  onCancel?: () => void;
  onOpenErrorReport?: () => void;
  onOpenLogFolder?: () => void;
  onReset?: () => Promise<AppSettings | null>;
  onSubmit?: (settings: AppSettings) => void;
  settings?: AppSettings;
} = {}): ReturnType<typeof render> {
  return render(
    <FontsContext.Provider
      value={{
        catalog: DEFAULT_BLOCK_FONT_CATALOG,
        baseOptions: getBaseBlockFontOptions(DEFAULT_BLOCK_FONT_CATALOG),
        options: getBlockFontOptions(DEFAULT_BLOCK_FONT_CATALOG),
        ready: true,
        busy: false,
        registerFont: () => Promise.resolve(),
        removeFont: () => Promise.resolve(),
        savePreferences: () => Promise.resolve(),
      }}
    >
      <SettingsModal
        initialSettings={settings}
        busy={busy}
        jobActive={false}
        openRequest={openRequest}
        onCancel={onCancel}
        onOpenErrorReport={onOpenErrorReport}
        onOpenLogFolder={onOpenLogFolder}
        onReset={onReset}
        onSubmit={onSubmit}
      />
    </FontsContext.Provider>,
  );
}
