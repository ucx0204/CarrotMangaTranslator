import { asRecord, type JsonRecord } from "./codexAppServerProtocol";
import type { CodexAppServerTransport } from "./codexAppServerTransport";
import { redactDiagnosticText } from "./errorReportRedaction";
import { logWarn, serializeLogDetail } from "./logger";

/** Preserve tool output before the caller deletes its ephemeral thread. */
export async function captureCodexImageFailure(
  transport: CodexAppServerTransport,
  reason: unknown,
  threadId: string,
  turnId: string | null,
  stderrSince: number,
  signal?: AbortSignal,
): Promise<Error> {
  let snapshot = transport.readTurnDiagnostics(threadId, turnId, stderrSince);
  let collectionError: unknown;
  if (hasUnfinishedImageFailure(snapshot.notifications)) {
    try {
      await transport.waitForNotification(
        (event) => isFailureDetail(event, threadId, turnId),
        1_500,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      // Diagnostic timeout/disconnect is secondary to the original image failure.
      collectionError = error;
    }
    snapshot = transport.readTurnDiagnostics(threadId, turnId, stderrSince);
  }
  const events = snapshot.notifications.flatMap(diagnosticEvents).slice(-12);
  const error = reason instanceof Error ? reason : new Error(String(reason));
  const processError = readImageStderrError(snapshot.processStderr);
  const diagnostics = JSON.parse(
    serializeLogDetail({
      threadId,
      turnId,
      codexVersion: transport.version,
      events,
      processStderr: diagnosticText(snapshot.processStderr),
      processError,
      collectionError,
    }),
  ) as JsonRecord;
  const detail =
    [...events]
      .reverse()
      .find((event) => typeof event.detail === "string" && event.detail)
      ?.detail ?? processError?.message;
  error.message = diagnosticText(error.message);
  if (error.message === 'ImageGen 실패: "failed"' && typeof detail === "string")
    error.message = `ImageGen 실패: ${detail.slice(0, 600)}`;
  Object.assign(error, {
    threadId,
    turnId,
    imageGenerationDiagnostics: diagnostics,
  });
  logWarn("Codex ImageGen request failed", describeCodexImageFailure(error));
  return error;
}

export function describeCodexImageFailure(reason: unknown): JsonRecord {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  const fields = error as Error & JsonRecord;
  return JSON.parse(
    serializeLogDetail({
      name: error.name,
      message: diagnosticText(error.message),
      stack: diagnosticText(error.stack),
      code: fields.code,
      status: fields.status,
      threadId: fields.threadId,
      turnId: fields.turnId,
      itemId: fields.itemId,
      imageGenerationDiagnostics: fields.imageGenerationDiagnostics,
      processStderr: diagnosticText(fields.recentStderr),
    }),
  ) as JsonRecord;
}

function hasUnfinishedImageFailure(events: JsonRecord[]): boolean {
  return (
    events.some((event) => {
      const item = asRecord(asRecord(event.params)?.item);
      return (
        event.method === "item/completed" &&
        item?.type === "imageGeneration" &&
        item.status !== "completed"
      );
    }) && !events.some((event) => event.method === "turn/completed")
  );
}

function isFailureDetail(
  event: JsonRecord,
  threadId: string,
  turnId: string | null,
): boolean {
  const params = asRecord(event.params) ?? {};
  if (params?.threadId !== threadId || turnId === null) return false;
  if (event.method === "turn/completed")
    return asRecord(params.turn)?.id === turnId;
  if (params.turnId !== turnId) return false;
  return (
    (event.method === "error" && params.willRetry !== true) ||
    (event.method === "item/completed" &&
      asRecord(params.item)?.type === "functionCallOutput")
  );
}

function diagnosticEvents(event: JsonRecord): JsonRecord[] {
  const params = asRecord(event.params) ?? {};
  if (event.method === "error")
    return [
      {
        method: event.method,
        error: diagnosticError(params.error),
        detail: diagnosticText(asRecord(params.error)?.message),
      },
    ];
  const turn = asRecord(params.turn) ?? {};
  if (event.method === "turn/completed") {
    const items = Array.isArray(turn.items) ? turn.items : [];
    return [
      {
        method: event.method,
        status: turn.status,
        error: diagnosticError(turn.error),
        detail: diagnosticText(asRecord(turn.error)?.message),
      },
      ...items.flatMap(diagnosticItem),
    ];
  }
  return event.method === "item/completed" ? diagnosticItem(params.item) : [];
}

function diagnosticItem(value: unknown): JsonRecord[] {
  const item = asRecord(value);
  if (item?.type === "imageGeneration")
    return [
      {
        type: item.type,
        itemId: item.id,
        status: item.status,
        failure: item.failure,
        detail: item.status === "completed" ? "" : diagnosticText(item.result),
      },
    ];
  if (item?.type !== "functionCallOutput") return [];
  const content = Array.isArray(item.output)
    ? item.output
        .flatMap((part) => {
          const entry = asRecord(part);
          return entry?.type === "input_text"
            ? [diagnosticText(entry.text)]
            : [];
        })
        .join("\n")
    : diagnosticText(item.output);
  return [
    {
      type: item.type,
      itemId: item.id,
      name: item.name,
      namespace: item.namespace,
      detail: content.slice(0, 8_000),
    },
  ];
}

function diagnosticError(value: unknown): JsonRecord | string {
  const error = asRecord(value);
  if (!error) return diagnosticText(value);
  return {
    message: diagnosticText(error.message),
    additionalDetails: diagnosticText(error.additionalDetails),
    codexErrorInfo: error.codexErrorInfo,
    status: error.status,
    code: error.code,
    requestId: error.requestId,
  };
}

function diagnosticText(value: unknown): string {
  if (typeof value !== "string") return "";
  // HTTP headers and encoded media are unnecessary for diagnosing tool failures.
  const text = value
    .replace(/headers=\{[^\r\n]*/gi, "headers=<redacted>")
    .replace(
      /(?:set-cookie|cookie|authorization)\s*:[^\r\n]*/gi,
      "<redacted-header>",
    )
    .replace(/data:(?:image|audio)\/[^\s"'<>]+/gi, "<redacted-media>")
    .replace(/[A-Za-z0-9+/=]{512,}/g, "<redacted-encoded-data>");
  return redactDiagnosticText(text).text.slice(0, 8_000);
}

function readImageStderrError(stderr: string): JsonRecord | undefined {
  for (const line of stderr.split("\n").reverse()) {
    try {
      const event = asRecord(JSON.parse(line));
      const error = asRecord(event?.fields)?.error;
      if (
        event?.level !== "ERROR" ||
        typeof error !== "string" ||
        !error.startsWith("image generation failed:")
      )
        continue;
      return decodeImageStderrError(error);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Partial/non-JSON stderr is retained as context, never guessed to be a provider error.
    }
  }
  return undefined;
}

function decodeImageStderrError(error: string): JsonRecord {
  const encoded = /Some\((".*")\)$/u.exec(error)?.[1];
  if (!encoded) return { message: diagnosticText(error) };
  const payload = asRecord(JSON.parse(JSON.parse(encoded) as string));
  const upstream = asRecord(payload?.error);
  if (!upstream) return { message: diagnosticText(error) };
  return {
    message: diagnosticText(upstream.message),
    code: upstream.code,
    type: upstream.type,
    moderationDetails: upstream.moderation_details,
  };
}
