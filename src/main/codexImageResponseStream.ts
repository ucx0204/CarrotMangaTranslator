import { asRecord, type JsonRecord } from "./codexAppServerProtocol";
import { redactDiagnosticText } from "./errorReportRedaction";

/** Retain provider failures, including failures after an image item completed. */
export async function readCodexImageResponse(
  response: Response,
): Promise<JsonRecord> {
  if (!response.body) throw new Error("Codex 이미지 응답 본문이 없습니다.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state: ImageStreamState = { images: new Map() };
  let pending = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      bytes += chunk.value?.byteLength ?? 0;
      if (bytes > 128 * 1024 * 1024)
        throw new Error("Codex 이미지 응답이 너무 큽니다.");
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() ?? "";
      for (const frame of frames) consumeFrame(frame, state);
      if (chunk.done) break;
    }
    if (pending.trim()) consumeFrame(pending, state);
    return completedImageResponse(state);
  } finally {
    await reader.cancel().catch((_error) => {
      // error-policy-allow: cancellation is best-effort after a completed or failed stream read.
    });
    reader.releaseLock();
  }
}

type ImageStreamState = {
  completed?: JsonRecord;
  failure?: Error;
  images: Map<string, JsonRecord>;
};

function consumeFrame(frame: string, state: ImageStreamState) {
  const data = frame
    .split(/\r?\n/)
    .flatMap((line) =>
      line.startsWith("data:") ? [line.slice(5).trimStart()] : [],
    )
    .join("\n");
  if (!data || data === "[DONE]") return;
  const event = asRecord(JSON.parse(data));
  if (!event) throw new Error("Codex 이미지 이벤트 형식이 올바르지 않습니다.");
  if (
    ["error", "response.failed", "response.incomplete"].includes(
      String(event.type),
    )
  ) {
    const result = asRecord(event.response);
    state.failure = codexImageResponseError(
      result?.error ?? event.error ?? event,
      502,
    );
  }
  if (event.type === "response.completed")
    state.completed = asRecord(event.response) ?? undefined;
  consumeImageItem(event, state);
}

function consumeImageItem(event: JsonRecord, state: ImageStreamState) {
  const item = asRecord(event.item);
  if (item?.type !== "image_generation_call") return;
  if (event.type === "response.output_item.done" && typeof item.id === "string")
    state.images.set(item.id, item);
  if (item.status === "failed" || item.error)
    state.failure = codexImageResponseError(item.error ?? item, 502);
}

function completedImageResponse(state: ImageStreamState) {
  if (state.failure) throw state.failure;
  if (!state.completed)
    throw new Error("Codex 이미지 응답이 완료되기 전에 끊겼습니다.");
  const output = Array.isArray(state.completed.output)
    ? state.completed.output
    : [];
  return {
    ...state.completed,
    output: [
      ...output,
      ...[...state.images.values()].filter(
        (image) => !output.some((item) => asRecord(item)?.id === image.id),
      ),
    ],
  };
}

export function codexImageResponseError(value: unknown, status: number): Error {
  const record = asRecord(value);
  const error = asRecord(record?.error) ?? record;
  const message = redactDiagnosticText(
    typeof error?.message === "string"
      ? error.message
      : "이미지 생성 요청에 실패했습니다.",
  ).text.slice(0, 1500);
  return Object.assign(new Error(`Codex ImageGen (${status}): ${message}`), {
    status,
    httpStatus: status,
    code: typeof error?.code === "string" ? error.code : undefined,
    moderation_details: error?.moderation_details,
    nonRetriable: true,
  });
}
