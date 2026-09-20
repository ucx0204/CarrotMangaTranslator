/** @vitest-environment jsdom */
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { appI18n } from "../src/renderer/src/appI18n";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { SettingsModal } from "../src/renderer/src/components/SettingsModal";
import { getSettingsSubmissionIssue } from "../src/renderer/src/components/settingsModal/settingsSubmissionIssue";
import { createSettingsFormValues } from "../src/renderer/src/components/settingsModal/settingsModalFormValues";
import {
  isSettingsFormSubmittable,
  resolveSettingsDraft,
} from "../src/renderer/src/components/settingsModal/settingsModalFormUtils";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "mangaApi");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("explains exactly the invalid drafts rejected by the submission boundary", () => {
  const base = createSettingsFormValues(resolveDefaultAppSettings({}));
  const invalid = {
    maxTokens: "invalid",
    contextTokens: "invalid",
    sourceLanguage: "!",
    targetLanguage: "!",
    researchGemmaMaxOutputTokens: "invalid",
    researchGemmaContextTokens: "invalid",
    researchApiMaxOutputTokens: "invalid",
    researchApiContextTokens: "invalid",
    researchCodexMaxOutputTokens: "invalid",
    researchCodexContextTokens: "invalid",
    tavilyMaxCreditsPerRun: "-1",
    researchCodexModel: "",
    researchApiModel: "",
    apiBaseUrl: "!",
    apiModel: "",
    apiTemperature: "3",
    apiTopP: "2",
    apiTopK: "1.1",
    apiKeyMaxAttempts: "-1",
    apiRetryDelaySeconds: "-1",
    apiRequestIntervalSeconds: "-1",
    apiKey: Array.from({ length: 200 }, (_, index) => `key-${index}`).join(
      "\n",
    ),
    apiExtraBodyJson: "{",
    apiCustomHeadersJson: '{"authorization":"secret"}',
    codexModel: "",
    localModelPath: "",
    customModelRepo: "",
    customModelFile: "",
    apiVertexServiceAccountPath: "",
  };
  for (const modelProvider of [
    "gemma",
    "openai-api",
    "openai-codex",
  ] as const) {
    for (const researchTavilyAnalysisProvider of ["gemma", "api"] as const) {
      for (const modelSource of ["local", "huggingface"] as const) {
        const values = {
          ...base,
          modelProvider,
          researchTavilyAnalysisProvider,
          modelSource,
          selectedPreset: "custom" as const,
          localModelPath: "model.gguf",
          customModelRepo: "repo",
          customModelFile: "file.gguf",
          apiProvider: "google-vertex" as const,
          apiVertexAuthMode: "service-account" as const,
          apiVertexServiceAccountPath: "account.json",
        };
        for (const patch of [
          {},
          ...Object.entries(invalid).map(([key, value]) => ({ [key]: value })),
        ]) {
          const next = { ...values, ...patch };
          const draft = resolveSettingsDraft(next);
          const issue = getSettingsSubmissionIssue(
            next,
            draft,
            appI18n.getFixedT("ko", "components"),
          );
          expect(
            Boolean(issue),
            JSON.stringify({ modelProvider, modelSource, patch }),
          ).toBe(!isSettingsFormSubmittable(next, draft));
          expect(String(issue?.message)).not.toMatch(/settings\./);
        }
      }
    }
  }
});

it("keeps API errors beside Save across tabs and returns focus to the invalid field", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  window.mangaApi = createTestMangaGatewayStub();
  const initialSettings = resolveDefaultAppSettings({});
  initialSettings.modelProvider = "openai-api";
  const onSubmit = vi.fn();
  render(
    <SettingsModal
      initialSettings={initialSettings}
      busy={false}
      jobActive={false}
      onCancel={vi.fn()}
      onOpenLogFolder={vi.fn()}
      onOpenErrorReport={vi.fn()}
      onReset={async () => null}
      onSubmit={onSubmit}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "AI" }));
  const label = appI18n.t("settings.api.advanced.extraBody", {
    ns: "components",
  });
  fireEvent.change(screen.getByLabelText(label), { target: { value: "{" } });
  fireEvent.click(screen.getByRole("tab", { name: "하드웨어" }));
  expect(screen.getByRole("button", { name: "저장" })).toHaveProperty(
    "disabled",
    true,
  );
  const reveal = screen.getByRole("button", { name: "오류 위치로 이동" });
  expect(reveal.parentElement?.textContent).toContain(label);
  fireEvent.click(reveal);
  const field = await screen.findByLabelText(label);
  await waitFor(() => expect(document.activeElement).toBe(field));
  fireEvent.change(field, { target: { value: '{"seed":123}' } });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "오류 위치로 이동" }),
    ).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  expect(onSubmit).toHaveBeenCalledOnce();
});
