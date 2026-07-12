import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type {
  AppSettings,
  ModelProvider,
} from "../../../../shared/settingsTypes";
import { mangaGateway } from "../../api/mangaGateway";
import {
  buildTestDetail,
  formatModelTestProgressLine,
} from "../settingsModalHelpers";
import type { SettingsTestStateController } from "./useSettingsTestState";

export function useSettingsModelTest({
  appendTestLogLine,
  buildSettings,
  canSubmit,
  jobActive,
  modelProvider,
  setTestState,
}: {
  appendTestLogLine: SettingsTestStateController["appendTestLogLine"];
  buildSettings: () => AppSettings | null;
  canSubmit: boolean;
  jobActive: boolean;
  modelProvider: ModelProvider;
  setTestState: SettingsTestStateController["setTestState"];
}): () => Promise<void> {
  const { t } = useTranslation("components");
  return React.useCallback(async () => {
    const nextSettings = buildSettings();
    if (!nextSettings || !canSubmit || jobActive) {
      return;
    }

    const testId = `settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    appendTestLogLine(t("settings.test.log.start"));
    setTestState({
      status: "running",
      message: t("settings.test.status.running"),
      detail: resolveModelTestRunningDetail(modelProvider, t),
    });
    const unsubscribe = subscribeModelTestProgress({
      appendTestLogLine,
      setTestState,
      testId,
    });
    try {
      await runModelTestRequest({
        appendTestLogLine,
        nextSettings,
        setTestState,
        testId,
        t,
      });
    } catch (error) {
      console.error(error);
      const requestError = t("settings.test.log.requestError");
      appendTestLogLine(requestError);
      setTestState({
        status: "error",
        message: requestError,
        detail: null,
      });
    } finally {
      unsubscribe();
    }
  }, [
    appendTestLogLine,
    buildSettings,
    canSubmit,
    jobActive,
    modelProvider,
    setTestState,
    t,
  ]);
}

function resolveModelTestRunningDetail(
  modelProvider: ModelProvider,
  t: TFunction<"components">,
): string {
  if (modelProvider === "gemma") {
    return t("settings.test.status.gemmaDetail");
  }
  if (modelProvider === "openai-codex") {
    return t("settings.test.status.codexDetail");
  }
  return t("settings.test.status.apiDetail");
}

function subscribeModelTestProgress({
  appendTestLogLine,
  setTestState,
  testId,
}: {
  appendTestLogLine: SettingsTestStateController["appendTestLogLine"];
  setTestState: SettingsTestStateController["setTestState"];
  testId: string;
}): () => void {
  return mangaGateway.onModelTestEvent((event) => {
    if (event.id !== testId) {
      return;
    }
    appendTestLogLine(formatModelTestProgressLine(event));
    setTestState((current) =>
      current.status === "running"
        ? {
            status: "running",
            message: event.progressText,
            detail: event.detail ?? current.detail,
          }
        : current,
    );
  });
}

async function runModelTestRequest({
  appendTestLogLine,
  nextSettings,
  setTestState,
  testId,
  t,
}: {
  appendTestLogLine: SettingsTestStateController["appendTestLogLine"];
  nextSettings: AppSettings;
  setTestState: SettingsTestStateController["setTestState"];
  testId: string;
  t: TFunction<"components">;
}): Promise<void> {
  const result = await mangaGateway.testModelSettings(nextSettings, testId);
  appendTestLogLine(
    result.ok ? t("settings.test.log.success") : t("settings.test.log.failure"),
  );
  setTestState({
    status: result.ok ? "success" : "error",
    message: result.message,
    detail: buildTestDetail(
      result.resolvedModelPath,
      result.resolvedMmprojPath,
      result.resolvedEndpoint,
      t,
    ),
  });
}
