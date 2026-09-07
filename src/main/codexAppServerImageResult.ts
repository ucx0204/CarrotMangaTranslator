import {
  asRecord,
  type CodexAppServerTurnResult,
  type JsonRecord,
} from "./codexAppServerProtocol";

export function extractCodexImageTurn(
  notification: JsonRecord,
  threadId: string,
  turnId: string,
): CodexAppServerTurnResult {
  const params = asRecord(notification.params);
  const turn = asRecord(params?.turn);
  const direct = asRecord(params?.item);
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const item =
    direct?.type === "imageGeneration"
      ? direct
      : items.map(asRecord).find((entry) => entry?.type === "imageGeneration");
  if (!item) throw new Error("ImageGen 결과를 받지 못했습니다.");
  if (item.status !== "completed" || item.failure) {
    throw new Error(
      `ImageGen 실패: ${JSON.stringify(item.failure ?? item.status)}`,
    );
  }
  return {
    threadId,
    turnId,
    itemId: typeof item.id === "string" ? item.id : null,
    text: JSON.stringify({
      result: item.result,
      savedPath: item.savedPath,
      revisedPrompt: item.revisedPrompt,
    }),
  };
}
