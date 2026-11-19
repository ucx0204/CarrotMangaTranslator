import { afterEach, expect, it, vi } from "vitest";

const {
  sendChatCompletion,
  readChatCompletionResult,
} = require("../src/main/runtime/transport/chat-completion.cjs");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("preserves a local server's ordinary JSON reply", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "완료" } }],
      }),
    ),
  );
  const options = { modelProvider: "gemma" };
  const response = await sendChatCompletion(
    { baseUrl: "http://localhost" },
    options,
    {},
    {},
  );
  await expect(
    readChatCompletionResult(response, options, {}, Date.now()),
  ).resolves.toMatchObject({ outputText: "완료" });
});

it("keeps remote APIs on their configured transport and reports invalid replies", async () => {
  const fetch = vi.fn(async () => new Response("invalid response"));
  vi.stubGlobal("fetch", fetch);
  const options = { modelProvider: "openai-api" };
  const response = await sendChatCompletion(
    { baseUrl: "https://provider.example/v1" },
    options,
    { model: "remote" },
    {},
    "test-key",
  );
  expect(fetch).toHaveBeenCalledWith(
    "https://provider.example/v1/chat/completions",
    expect.objectContaining({ body: '{"model":"remote"}' }),
  );
  await expect(
    readChatCompletionResult(response, options, {}, Date.now()),
  ).rejects.toThrow(/JSON parse failed/);
});

it("treats an underlying local HTTP headers timeout as terminal", async () => {
  const cause = Object.assign(new Error("Headers Timeout Error"), {
    code: "UND_ERR_HEADERS_TIMEOUT",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("fetch failed", { cause });
    }),
  );
  await expect(
    sendChatCompletion(
      { baseUrl: "http://localhost" },
      { modelProvider: "gemma" },
      {},
      {},
    ),
  ).rejects.toMatchObject({ nonRetriable: true, code: "GEMMA_IDLE_TIMEOUT" });
});

it("stops waiting for headers without retrying or returning partial output", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const attempt = sendChatCompletion(
    { baseUrl: "http://localhost" },
    { modelProvider: "gemma" },
    {},
    {},
  );
  const failure = expect(attempt).rejects.toMatchObject({
    code: "GEMMA_IDLE_TIMEOUT",
    nonRetriable: true,
  });
  await vi.advanceTimersByTimeAsync(300_001);
  await failure;
  expect(fetch).toHaveBeenCalledTimes(1);
});

function streamFixture() {
  let writer: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      writer = controller;
    },
    cancel: cancelled,
  });
  const fetch = vi.fn(
    async () =>
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
  );
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const onProgress = vi.fn();
  const options = {
    modelProvider: "gemma",
    abortSignal: controller.signal,
    onProgress,
  };
  const result = sendChatCompletion(
    { baseUrl: "http://localhost" },
    options,
    {},
    {},
  ).then((response: Response) =>
    readChatCompletionResult(response, options, {}, Date.now()),
  );
  const write = (s: string) => writer.enqueue(new TextEncoder().encode(s));
  return {
    write,
    end: () => writer.close(),
    controller,
    result,
    fetch,
    onProgress,
    cancelled,
  };
}

it("waits through long prompt evaluation and generation and preserves the completion contract", async () => {
  vi.useFakeTimers();
  const f = streamFixture();
  for (const processed of [0, 500, 1000]) {
    f.write(
      `data: ${JSON.stringify({ prompt_progress: { processed, total: 1000 } })}\r\n\r\n`,
    );
    await vi.advanceTimersByTimeAsync(120_000);
  }
  f.write('data: {"choices":[{"delta":{"content":"완');
  f.write(
    '료","reasoning_content":"reason"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}],"timings":{"predicted_n":2}}\n\n',
  );
  f.write(
    'data: {"usage":{"completion_tokens":2},"choices":[]}\n\ndata: [DONE]\n\n',
  );
  f.end();
  await expect(f.result).resolves.toMatchObject({
    outputText: "완료",
    rawResponse: {
      usage: { completion_tokens: 2 },
      timings: { predicted_n: 2 },
      choices: [{ message: { reasoning_content: "reason" } }],
    },
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.onProgress).toHaveBeenCalledWith(
    expect.objectContaining({ progressText: "Gemma 입력 읽는 중" }),
  );
  expect(f.onProgress).toHaveBeenCalledWith(
    expect.objectContaining({ progressText: "Gemma 번역문 생성 중" }),
  );
});

it("aborts an idle request even when llama sends heartbeats and duplicate prompt counters", async () => {
  vi.useFakeTimers();
  const f = streamFixture();
  const error = expect(f.result).rejects.toMatchObject({
    nonRetriable: true,
    code: "GEMMA_IDLE_TIMEOUT",
  });
  const frame = 'data: {"prompt_progress":{"processed":1,"total":40}}\n\n';
  f.write(frame);
  await vi.advanceTimersByTimeAsync(150_000);
  f.write(": ping\n\n" + frame);
  await vi.advanceTimersByTimeAsync(150_001);
  await error;
  expect(f.cancelled).toHaveBeenCalledTimes(1);
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

it("cancels before the first token and rejects a truncated stream", async () => {
  const cancelled = streamFixture();
  cancelled.controller.abort();
  await expect(cancelled.result).rejects.toMatchObject({ name: "AbortError" });
  const interrupted = streamFixture();
  interrupted.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  interrupted.end();
  await expect(interrupted.result).rejects.toThrow();
});
