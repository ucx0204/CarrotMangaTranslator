import { beforeEach, describe, expect, it, vi } from "vitest";
import { askAstraJson } from "../src/main/pipeline/codexTypesettingRequest";

const { pause } = vi.hoisted(() => ({ pause: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: pause }));

const capacity = new Error(
  "Selected model is at capacity. Please try a different model.",
);
const response = {
  text: '{"summary":"ok","regions":[]}',
  threadId: "thread",
  turnId: "turn",
  itemId: null,
  routedModel: "gpt-6-astra",
  tokenUsage: { totalTokens: 30 },
};

function setup() {
  const controller = new AbortController();
  const runEphemeralTurn = vi.fn().mockResolvedValue(response);
  const evidence = vi.fn().mockResolvedValue(undefined);
  return {
    controller,
    request: {
      client: { runEphemeralTurn },
      stage: "read-page",
      prompt: "Read this Japanese page",
      images: [{ label: "source", dataUrl: "data:image/png;base64,c291cmNl" }],
      cwd: "chapter",
      signal: controller.signal,
      evidence,
      onRetry: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pause.mockResolvedValue(undefined);
});

describe("Astra request evidence and bounded capacity recovery", () => {
  it.each(["low", "medium", "high", "xhigh"] as const)(
    "uses the selected %s effort without upgrading it",
    async (effort) => {
      const { request } = setup();
      await askAstraJson({ ...request, effort });
      expect(request.client.runEphemeralTurn).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-6-astra", effort }),
      );
    },
  );
  it("passes the registered preview tool and requires inspection before binding the exact artifact", async () => {
    const { request } = setup();
    const previewTool = {
      inputSchema: { type: "object" },
      execute: vi.fn(async () => ({ success: true, contentItems: [] })),
    };
    await askAstraJson({ ...request, stage: "erase-page", previewTool });
    const input = request.client.runEphemeralTurn.mock.calls[0][0];
    expect(input.previewTool).toBe(previewTool);
    expect(input.instructions).toContain(
      "use preview_erasure and inspect every actual result",
    );
    expect(input.instructions).toContain("exact unresolvedRegionIds");
    expect(input.outputSchema.properties.sha256).toBeDefined();
    expect(input.outputSchema.properties.regions).toBeUndefined();
  });
  it("records request evidence before transport and preserves original image detail and accounting", async () => {
    const { request } = setup();
    request.client.runEphemeralTurn.mockImplementation(async () => {
      expect(request.evidence).toHaveBeenCalledWith(
        "request-read-page-attempt-0",
        expect.objectContaining({ status: "started" }),
      );
      return response;
    });
    expect(await askAstraJson(request)).toEqual({ summary: "ok", regions: [] });
    expect(request.client.runEphemeralTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-6-astra",
        effort: "high",
        signal: request.signal,
        outputSchema: expect.objectContaining({ type: "object" }),
        input: [
          { type: "text", text: request.prompt },
          { type: "text", text: "source" },
          { type: "image", url: request.images[0].dataUrl, detail: "original" },
        ],
      }),
    );
    expect(request.evidence).toHaveBeenLastCalledWith(
      "call-read-page",
      expect.objectContaining({
        status: "completed",
        attempt: 0,
        tokenUsage: { totalTokens: 30 },
        images: [
          { label: "source", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        ],
      }),
    );
    expect(pause).not.toHaveBeenCalled();
  });

  it("retries only the rejected request twice on the same Astra and records unknown failed usage", async () => {
    const { request } = setup();
    request.client.runEphemeralTurn
      .mockRejectedValueOnce(capacity)
      .mockRejectedValueOnce(capacity);
    await askAstraJson(request);
    expect(request.client.runEphemeralTurn).toHaveBeenCalledTimes(3);
    const calls = request.client.runEphemeralTurn.mock.calls;
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]).toEqual(calls[0]);
    expect(pause.mock.calls.map((call) => call[0])).toEqual([15_000, 45_000]);
    expect(request.onRetry.mock.calls).toEqual([
      [1, 15_000],
      [2, 45_000],
    ]);
    for (const attempt of [0, 1])
      expect(request.evidence).toHaveBeenCalledWith(
        `call-read-page-attempt-${attempt}`,
        expect.objectContaining({
          status: "failed",
          tokenUsage: null,
          error: capacity.message,
        }),
      );
    expect(request.evidence).toHaveBeenLastCalledWith(
      "call-read-page",
      expect.objectContaining({ attempt: 2 }),
    );
  });

  it("stops after the third capacity rejection and does not fabricate a completion", async () => {
    const { request } = setup();
    request.client.runEphemeralTurn.mockRejectedValue(capacity);
    await expect(askAstraJson(request)).rejects.toBe(capacity);
    expect(request.client.runEphemeralTurn).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(
      request.evidence.mock.calls.filter(([name]) => name === "call-read-page"),
    ).toHaveLength(0);
  });

  it.each([
    new Error("Timed out waiting for response"),
    new Error("Authentication failed"),
    "unknown error",
  ])("does not retry an ambiguous or permanent failure: %s", async (error) => {
    const { request } = setup();
    request.client.runEphemeralTurn.mockRejectedValue(error);
    await expect(askAstraJson(request)).rejects.toBe(error);
    expect(request.client.runEphemeralTurn).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and a different routed model without another paid request", async () => {
    for (const update of [
      { text: "not JSON" },
      { routedModel: "gpt-5.6-sol" },
    ]) {
      const { request } = setup();
      request.client.runEphemeralTurn.mockResolvedValue({
        ...response,
        ...update,
      });
      await expect(askAstraJson(request)).rejects.toBeInstanceOf(Error);
      expect(request.client.runEphemeralTurn).toHaveBeenCalledTimes(1);
      expect(request.evidence).toHaveBeenLastCalledWith(
        "call-read-page",
        expect.objectContaining({ ...update }),
      );
    }
    expect(pause).not.toHaveBeenCalled();
  });

  it("cancels before a request and while the real capacity delay is pending", async () => {
    const first = setup();
    first.controller.abort(new Error("cancel before start"));
    await expect(askAstraJson(first.request)).rejects.toThrow(
      "cancel before start",
    );
    expect(first.request.client.runEphemeralTurn).not.toHaveBeenCalled();
    const { request, controller } = setup();
    const timers = await vi.importActual<typeof import("node:timers/promises")>(
      "node:timers/promises",
    );
    pause.mockImplementation(timers.setTimeout);
    request.client.runEphemeralTurn.mockRejectedValue(capacity);
    request.onRetry.mockImplementation(() => {
      setImmediate(() => controller.abort());
    });
    await expect(askAstraJson(request)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(request.client.runEphemeralTurn).toHaveBeenCalledTimes(1);
  });

  it("records cancellation without interpreting it as retryable capacity", async () => {
    const { request, controller } = setup();
    request.client.runEphemeralTurn.mockImplementation(async () => {
      controller.abort(new Error("cancelled during request"));
      throw capacity;
    });
    await expect(askAstraJson(request)).rejects.toThrow(
      "cancelled during request",
    );
    expect(request.evidence).toHaveBeenLastCalledWith(
      "call-read-page-attempt-0",
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(pause).not.toHaveBeenCalled();
  });

  it("does not call the model without start evidence and preserves both request and evidence failures", async () => {
    const { request } = setup();
    const io = new Error("disk full");
    request.evidence.mockRejectedValueOnce(io);
    await expect(askAstraJson(request)).rejects.toBe(io);
    expect(request.client.runEphemeralTurn).not.toHaveBeenCalled();
    request.evidence.mockResolvedValueOnce(undefined).mockRejectedValueOnce(io);
    request.client.runEphemeralTurn.mockRejectedValueOnce(capacity);
    await expect(askAstraJson(request)).rejects.toMatchObject({
      errors: [capacity, io],
    });
    expect(pause).not.toHaveBeenCalled();
  });
});
