import React from "react";
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
  return React.useCallback(async () => {
    const nextSettings = buildSettings();
    if (!nextSettings || !canSubmit || jobActive) {
      return;
    }

    const testId = `settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    appendTestLogLine("Paddle OCR과 번역 엔진 확인을 시작합니다.");
    setTestState({
      status: "running",
      message:
        "OCR, 모델 런타임, 간단한 텍스트 응답을 차례대로 확인하는 중입니다...",
      detail: resolveModelTestRunningDetail(modelProvider),
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
      });
    } catch (error) {
      appendTestLogLine(
        "Paddle OCR과 번역 엔진 확인 요청 중 오류가 발생했습니다.",
      );
      setTestState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
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
  ]);
}

function resolveModelTestRunningDetail(modelProvider: ModelProvider): string {
  if (modelProvider === "gemma") {
    return "Paddle OCR과 Gemma 실행 런타임 준비 로그를 함께 표시합니다.";
  }
  if (modelProvider === "openai-codex") {
    return "Paddle OCR과 Codex 엔드포인트 준비 상태를 함께 확인합니다.";
  }
  return "Paddle OCR과 API 엔드포인트 응답을 함께 확인합니다.";
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
}: {
  appendTestLogLine: SettingsTestStateController["appendTestLogLine"];
  nextSettings: AppSettings;
  setTestState: SettingsTestStateController["setTestState"];
  testId: string;
}): Promise<void> {
  const result = await mangaGateway.testModelSettings(nextSettings, testId);
  appendTestLogLine(
    result.ok
      ? "Paddle OCR과 번역 엔진 확인이 완료되었습니다."
      : "Paddle OCR과 번역 엔진 확인이 실패했습니다.",
  );
  setTestState({
    status: result.ok ? "success" : "error",
    message: result.message,
    detail: buildTestDetail(
      result.resolvedModelPath,
      result.resolvedMmprojPath,
      result.resolvedEndpoint,
    ),
  });
}
