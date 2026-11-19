// @ts-check
const {
  buildChatRequestHeaders,
} = require("../simple-page-request-builders.cjs");
const { emitRuntimeProgress } = require("./model-runtime-services.cjs");
const {
  readBoundedResponseText,
  createResponseTooLargeError,
} = require("./bounded-response-body.cjs");
const { MAX_MODEL_HTTP_RESPONSE_BYTES } = require("./network-budgets.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { abortSignal?: AbortSignal | null }} Options */

/** Local llama reports prompt batches and generated text on the same request. */
/** @param {string} url @param {Options} options @param {Record<string, unknown>} body @param {Record<string, unknown>} summary */
async function fetchLocalGemmaCompletion(url, options, body, summary) {
  const controller = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([controller.signal, options.abortSignal])
    : controller.signal;
  const idleMs = 300_000;
  let stage = "응답 대기";
  let lastReport = 0;
  const stalled = () =>
    Object.assign(
      new Error(
        `Gemma ${stage} 중 5분 동안 진행이 없어 이 페이지의 번역을 중단했습니다.`,
      ),
      {
        nonRetriable: true,
        requestDeadlineExceeded: true,
        failureCategory: "model-request",
        code: "GEMMA_IDLE_TIMEOUT",
        requestSummary: summary,
      },
    );
  const timer = setTimeout(() => controller.abort(stalled()), idleMs);
  /** @param {string} phase @param {string} detail */
  function progress(phase, detail) {
    timer.refresh();
    const now = Date.now();
    if (phase !== stage || now - lastReport >= 2000) {
      lastReport = now;
      emitRuntimeProgress(
        options,
        "model_requesting",
        `Gemma ${phase} 중`,
        detail,
      );
    }
    stage = phase;
    summary.gemmaProgress = { stage, detail };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildChatRequestHeaders(options, undefined),
      body: JSON.stringify({
        ...body,
        stream: true,
        return_progress: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });
    return await readLocalCompletion(response, signal, progress);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    controller.abort(error);
    if (
      error instanceof Error &&
      /** @type {{code?: string}|undefined} */ (error.cause)?.code ===
        "UND_ERR_HEADERS_TIMEOUT"
    )
      throw stalled();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** @typedef {(phase: string, detail: string) => void} ReportProgress */
/** @typedef {{ content: string, reasoning_content: string, refusal: string }} Message */
/** @typedef {{choices?: {delta?: Partial<Message> & {reasoning?: string}; finish_reason?: string}[]; prompt_progress?: {processed: number; total: number}; error?: {message: string}} & Record<string, unknown>} Chunk */

/** @param {Response} response @param {AbortSignal} signal @param {ReportProgress} progress */
async function readLocalCompletion(response, signal, progress) {
  if (!response.ok || !response.body) return response;
  if (!response.headers?.get?.("content-type")?.includes("text/event-stream")) {
    // Some local runtimes answer a streaming request with a single JSON body.
    const text = await readBoundedResponseText(response, {
      signal,
      label: "Gemma response",
      maximumBytes: MAX_MODEL_HTTP_RESPONSE_BYTES,
    });
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: { "Content-Type": "application/json" },
    });
  }
  const stream = collectGemmaChat(progress);
  await readBoundedResponseText(response, {
    signal,
    label: "Gemma stream",
    // SSE repeats the model ID, metadata and choice envelope per token.
    maximumBytes: 16 * MAX_MODEL_HTTP_RESPONSE_BYTES,
    onText: stream.append,
  });
  return Response.json(stream.finish());
}

/** @param {Chunk} event @param {Record<string, unknown>} metadata */
function collectMetadata(event, metadata) {
  for (const key of [
    "id",
    "model",
    "created",
    "timings",
    "usage",
    "system_fingerprint",
  ]) {
    if (event[key] != null) metadata[key] = event[key];
  }
}

/** @param {Message} message @param {Partial<Message> & {reasoning?: string}} delta */
function appendDelta(message, delta) {
  const text = delta.content ?? "";
  const thought = delta.reasoning_content ?? delta.reasoning ?? "";
  const refusal = delta.refusal ?? "";
  message.content += text;
  message.reasoning_content += thought;
  message.refusal += refusal;
  return (
    Buffer.byteLength(text) +
    Buffer.byteLength(thought) +
    Buffer.byteLength(refusal)
  );
}

/** @param {ReportProgress} progress */
function collectGemmaChat(progress) {
  let pending = "",
    finishReason = "",
    processed = -1,
    bytes = 0;
  let done = false;
  const message = {
    role: "assistant",
    content: "",
    reasoning_content: "",
    refusal: "",
  };
  /** @type {Record<string, unknown>} */
  const metadata = {};
  /** @param {Chunk} event */
  function accept(event) {
    if (event.error) throw new Error(`Gemma: ${event.error.message}`);
    collectMetadata(event, metadata);
    const prompt = event.prompt_progress;
    if (
      prompt &&
      Number.isFinite(prompt.processed) &&
      prompt.processed > processed
    ) {
      processed = prompt.processed;
      progress("입력 읽는", `${processed} / ${prompt.total} 토큰`);
    }
    const choice = event.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (!choice?.delta) return;
    const added = appendDelta(message, choice.delta);
    if (!added) return;
    bytes += added;
    if (bytes > MAX_MODEL_HTTP_RESPONSE_BYTES)
      throw createResponseTooLargeError(
        "Gemma response",
        MAX_MODEL_HTTP_RESPONSE_BYTES,
        bytes,
      );
    progress(
      "번역문 생성",
      `응답 ${message.content.length + message.reasoning_content.length + message.refusal.length}자 수신`,
    );
  }
  /** @param {string} line */
  function consume(line) {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") done = true;
    else if (data) accept(JSON.parse(data));
  }
  return {
    /** @param {string} text */
    append(text) {
      const lines = (pending + text).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) consume(line);
    },
    finish() {
      consume(pending);
      if (!done || !finishReason)
        throw new Error("Gemma 번역 응답이 완료되기 전에 연결이 끊겼습니다.");
      return {
        ...metadata,
        choices: [
          {
            index: 0,
            finish_reason: finishReason,
            message: { ...message, refusal: message.refusal || null },
          },
        ],
      };
    },
  };
}

module.exports = { fetchLocalGemmaCompletion };
