import { requireImageRedactionReview } from "./imageRedactionContext";
import { app } from "electron";
import type { AppPaths } from "./appPaths";
import type { AppSettings } from "../shared/settingsTypes";
import { CODEX_TYPESETTING_MODEL } from "../shared/codexTypesettingDefaults";
import { CodexAppServerClient } from "./codexAppServerClient";
import { CODEX_IMAGE_MODELS } from "../shared/codexSettings";

/** Image jobs have their own model and effort, independent of text translation. */
export async function startCodexImageSession(
  paths: AppPaths,
  settings: AppSettings,
  directory: string,
  signal: AbortSignal,
  capability: "image-generation" | "isolated" = "image-generation",
) {
  await requireImageRedactionReview(paths.dataRoot);
  const connection = await CodexAppServerClient.start({
    paths: { ...paths, codexWorkspaceDir: directory },
    appVersion: app.getVersion(),
    capability,
    signal,
  });
  try {
    signal.throwIfAborted();
    const account = await connection.readAccount(false);
    if (account.account?.type !== "chatgpt")
      throw new Error("설정에서 Codex 계정을 연결해 주세요.");
    const effort = settings.codex.imageReasoningEffort ?? "low";
    const imageModel = settings.codex.imageModel ?? CODEX_TYPESETTING_MODEL;
    if (!CODEX_IMAGE_MODELS.some((id) => id === imageModel))
      throw new Error("선택한 Codex 이미지 작업 모델을 지원하지 않습니다.");
    const model = (await connection.listModels()).find(
      (item) => item.id === imageModel,
    );
    if (!model?.supportedReasoningEfforts.includes(effort))
      throw new Error(
        "선택한 Codex 이미지 작업 모델·추론 강도를 사용할 수 없습니다.",
      );
    return {
      imageModel,
      runEphemeralTurn: (
        request: Parameters<CodexAppServerClient["runEphemeralTurn"]>[0],
      ) =>
        connection.runEphemeralTurn({
          ...request,
          model: imageModel,
          effort,
        }),
      dispose: () => connection.dispose(),
    };
  } catch (error) {
    await connection.dispose();
    throw error;
  }
}
