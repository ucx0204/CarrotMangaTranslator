import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type {
  AppSettings,
  ModelProvider,
} from "../../../../shared/settingsTypes";
import { settingsGateway } from "../../api/settingsGateway";
import {
  buildTestDetail,
  formatModelTestProgressLine,
} from "../settingsModalHelpers";
import type { SettingsTestStateController } from "./useSettingsTestState";

type ModelTestLifecycle = {
  generation: number;
  mounted: boolean;
  unsubscribe: (() => void) | null;
};

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
  const lifecycleRef = useModelTestLifecycle();

  return React.useCallback(async () => {
    const lifecycle = lifecycleRef.current;
    if (!lifecycle.mounted) {
      return;
    }
    const nextSettings = buildSettings();
    if (!nextSettings || !canSubmit || jobActive) {
      return;
    }

    lifecycle.unsubscribe?.();
    lifecycle.unsubscribe = null;
    const generation = ++lifecycle.generation;
    const isActive = (): boolean =>
      lifecycle.mounted && lifecycle.generation === generation;
    const testId = `settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    appendTestLogLine(t("settings.test.log.start"));
    setTestState({
      status: "running",
      message: t("settings.test.status.running"),
      detail: resolveModelTestRunningDetail(modelProvider, t),
    });
    const unsubscribe = subscribeModelTestProgress({
      appendTestLogLine,
      isActive,
      setTestState,
      testId,
    });
    lifecycle.unsubscribe = unsubscribe;
    try {
      await runModelTestRequest({
        appendTestLogLine,
        isActive,
        nextSettings,
        setTestState,
        testId,
        t,
      });
    } catch (error) {
      reportModelTestRequestError({
        appendTestLogLine,
        error,
        isActive,
        setTestState,
        t,
      });
    } finally {
      releaseModelTestSubscription(lifecycle, generation, unsubscribe);
    }
  }, [
    appendTestLogLine,
    buildSettings,
    canSubmit,
    jobActive,
    lifecycleRef,
    modelProvider,
    setTestState,
    t,
  ]);
}

function useModelTestLifecycle(): React.RefObject<ModelTestLifecycle> {
  const lifecycleRef = React.useRef<ModelTestLifecycle>({
    generation: 0,
    mounted: true,
    unsubscribe: null,
  });
  React.useEffect(() => {
    const lifecycle = lifecycleRef.current;
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      lifecycle.generation += 1;
      lifecycle.unsubscribe?.();
      lifecycle.unsubscribe = null;
    };
  }, []);
  return lifecycleRef;
}

function releaseModelTestSubscription(
  lifecycle: ModelTestLifecycle,
  generation: number,
  unsubscribe: () => void,
): void {
  if (
    lifecycle.generation !== generation ||
    lifecycle.unsubscribe !== unsubscribe
  ) {
    return;
  }
  lifecycle.unsubscribe = null;
  unsubscribe();
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
  isActive,
  setTestState,
  testId,
}: {
  appendTestLogLine: SettingsTestStateController["appendTestLogLine"];
  isActive: () => boolean;
  setTestState: SettingsTestStateController["setTestState"];
  testId: string;
}): () => void {
  return settingsGateway.onModelTestEvent((event) => {
    if (!isActive() || event.id !== testId) {
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

function reportModelTestRequestError({
  appendTestLogLine,
  error,
  isActive,
  setTestState,
  t,
}: {
  appendTestLogLine: SettingsTestStateController["appendTestLogLine"];
  error: unknown;
  isActive: () => boolean;
  setTestState: SettingsTestStateController["setTestState"];
  t: TFunction<"components">;
}): void {
  if (!isActive()) {
    return;
  }
  console.error(error);
  const requestError = t("settings.test.log.requestError");
  appendTestLogLine(requestError);
  setTestState({
    status: "error",
    message: requestError,
    detail: null,
  });
}

async function runModelTestRequest({
  appendTestLogLine,
  isActive,
  nextSettings,
  setTestState,
  testId,
  t,
}: {
  appendTestLogLine: SettingsTestStateController["appendTestLogLine"];
  isActive: () => boolean;
  nextSettings: AppSettings;
  setTestState: SettingsTestStateController["setTestState"];
  testId: string;
  t: TFunction<"components">;
}): Promise<void> {
  const result = await settingsGateway.testModelSettings(nextSettings, testId);
  if (!isActive()) {
    return;
  }
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
