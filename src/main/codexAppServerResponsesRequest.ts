import type { CodexAppServerTurnInput } from "./codexAppServerProtocol";
import { asRecord, type JsonRecord } from "./codexAppServerProtocol";

export const MAX_CODEX_RESPONSES_REQUEST_BYTES = 192 * 1024 * 1024;
const DEFAULT_TRANSLATION_INSTRUCTIONS =
  "Follow the user's transformation request exactly and return only the requested final output.";

export type ParsedCodexResponsesRequest = {
  model: string;
  effort: string;
  instructions: string;
  input: CodexAppServerTurnInput[];
  outputSchema?: JsonRecord;
};

export function parseCodexResponsesRequest(
  value: unknown,
): ParsedCodexResponsesRequest {
  const record = asRecord(value);
  const model = readBoundedString(record?.model, "model", 120);
  const instructions =
    readOptionalBoundedString(record?.instructions, "instructions", 200_000) ??
    DEFAULT_TRANSLATION_INSTRUCTIONS;
  const reasoning = asRecord(record?.reasoning);
  const effort =
    readOptionalBoundedString(reasoning?.effort, "reasoning.effort", 32) ??
    "medium";
  const input = parseResponsesInput(record?.input);
  const outputSchema = parseOutputSchema(record);
  return {
    model,
    effort,
    instructions,
    input,
    ...(outputSchema ? { outputSchema } : {}),
  };
}

export function codexEndpointRequestError(
  message: string,
  cause?: unknown,
): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  Object.assign(error, { httpStatus: 400, nonRetriable: true });
  return error;
}

function parseResponsesInput(value: unknown): CodexAppServerTurnInput[] {
  if (typeof value === "string" && value.trim()) {
    return [{ type: "text", text: value }];
  }
  if (!Array.isArray(value)) {
    throw codexEndpointRequestError("input 배열이 필요합니다.");
  }
  const result = value.flatMap(parseResponseMessage);
  if (result.length === 0) {
    throw codexEndpointRequestError(
      "Codex 요청에 텍스트 또는 이미지가 없습니다.",
    );
  }
  return result;
}

function parseResponseMessage(value: unknown): CodexAppServerTurnInput[] {
  const message = asRecord(value);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.map(parseResponseContentPart);
}

function parseResponseContentPart(value: unknown): CodexAppServerTurnInput {
  const part = asRecord(value);
  if (part?.type === "input_text") return parseTextPart(part);
  if (part?.type === "input_image") return parseImagePart(part);
  throw codexEndpointRequestError("지원하지 않는 Codex 입력 형식입니다.");
}

function parseTextPart(part: JsonRecord): CodexAppServerTurnInput {
  return {
    type: "text",
    text: readBoundedString(part.text, "input_text.text", 300_000),
  };
}

function parseImagePart(part: JsonRecord): CodexAppServerTurnInput {
  const url = readBoundedString(
    part.image_url ?? part.imageUrl,
    "input_image.image_url",
    MAX_CODEX_RESPONSES_REQUEST_BYTES,
  );
  if (!url.startsWith("data:image/")) {
    throw codexEndpointRequestError(
      "Codex 이미지 입력은 data URL이어야 합니다.",
    );
  }
  return { type: "image", url, ...parseImageDetail(part.detail) };
}

function parseOutputSchema(record: JsonRecord | null): JsonRecord | undefined {
  const text = asRecord(record?.text);
  const format = asRecord(text?.format);
  return asRecord(format?.schema) ?? undefined;
}

function parseImageDetail(
  value: unknown,
): { detail: "low" | "high" | "original" } | Record<string, never> {
  return value === "low" || value === "high" || value === "original"
    ? { detail: value }
    : {};
}

function readBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  const parsed = readOptionalBoundedString(value, label, maxLength);
  if (!parsed) {
    throw codexEndpointRequestError(`${label} 문자열이 필요합니다.`);
  }
  return parsed;
}

function readOptionalBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw codexEndpointRequestError(
      `${label} 문자열 형식이 올바르지 않습니다.`,
    );
  }
  return value.trim() ? value : null;
}
