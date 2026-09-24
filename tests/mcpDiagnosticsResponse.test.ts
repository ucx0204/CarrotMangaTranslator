import { afterEach, expect, it, vi } from "vitest";
import { diagnoseMcpEndpoint } from "../src/main/mcp/mcpDiagnostics";
import {
  diagnosticAddresses,
  diagnosticFixture,
  jsonMetadata,
} from "./mcpDiagnostics.fixture";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const { resource, resourceMetadata } = diagnosticAddresses;

it.each(["status", "content-type", "invalid-json", "array", "network"])(
  "fails a %s response without reflecting body contents or transport secrets",
  async (mode) => {
    diagnosticFixture((url) => {
      if (url !== resourceMetadata) return undefined;
      if (mode === "network") throw new Error("PRIVATE transport URL/token");
      if (mode === "array") return jsonMetadata([]);
      return new Response("PRIVATE invalid JSON", {
        status: mode === "status" ? 503 : 200,
        headers: {
          "Content-Type":
            mode === "content-type" ? "text/html" : "application/json",
        },
      });
    });
    const result = await diagnoseMcpEndpoint(resource);
    expect(result.checks.map((check) => check.passed)).toEqual([
      false,
      true,
      true,
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  },
);

it.each(["declared", "streamed"])(
  "cancels an oversized %s metadata body while reading bytes",
  async (mode) => {
    const cancel = vi.fn();
    const encoded = new TextEncoder().encode(
      JSON.stringify({ value: "한".repeat(6000) }),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === "streamed") {
          controller.enqueue(encoded.slice(0, 8000));
          controller.enqueue(encoded.slice(8000));
        }
      },
      cancel,
    });
    diagnosticFixture((url) =>
      url === resourceMetadata
        ? new Response(body, {
            headers: {
              "Content-Type": "application/json",
              ...(mode === "declared" ? { "Content-Length": "16385" } : {}),
            },
          })
        : undefined,
    );
    const result = await diagnoseMcpEndpoint(resource);
    expect(result.checks[0]).toMatchObject({
      passed: false,
      message: expect.stringContaining("16KiB"),
    });
    expect(cancel).toHaveBeenCalledOnce();
  },
);

it.each(["connection", "body"])(
  "aborts a stalled %s at eight seconds and releases its deadline",
  async (mode) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let signal: AbortSignal | null | undefined;
    diagnosticFixture((url, init) => {
      if (url !== resourceMetadata) return undefined;
      signal = init.signal;
      if (!signal) throw new Error("A diagnostic deadline is required");
      if (mode === "connection") {
        const current = signal;
        return new Promise<Response>((_resolve, reject) => {
          current.addEventListener("abort", () => reject(current.reason), {
            once: true,
          });
        });
      }
      return new Response(new ReadableStream({ cancel }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const pending = diagnoseMcpEndpoint(resource);
    await vi.advanceTimersByTimeAsync(8000);
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(result.checks[0]).toMatchObject({
      passed: false,
      message: expect.stringContaining("8초"),
    });
    expect(result.checks.slice(1).every((check) => check.passed)).toBe(true);
    if (mode === "body") expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("cancels unused unauthorized response bodies and fails if their cleanup fails", async () => {
  const cancel = vi.fn(() => {
    throw new Error("PRIVATE cleanup failure");
  });
  diagnosticFixture((url) =>
    url === resource
      ? new Response(new ReadableStream({ cancel }), {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}"`,
          },
        })
      : undefined,
  );
  const result = await diagnoseMcpEndpoint(resource);
  expect(result.ok).toBe(false);
  expect(result.checks[2].passed).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

it("accepts a metadata body exactly at the byte limit", async () => {
  diagnosticFixture((url, _init, value) => {
    if (url !== resourceMetadata) return undefined;
    const content = JSON.stringify({
      ...(value as object),
      description: "한국어",
    });
    const size = new TextEncoder().encode(content).byteLength;
    return new Response(content + " ".repeat(16384 - size), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  });
  expect((await diagnoseMcpEndpoint(resource)).ok).toBe(true);
});

it.each(["unauthorized", "declared-overflow", "http-error"])(
  "keeps the eight-second bound when %s response cancellation stalls",
  async (mode) => {
    vi.useFakeTimers();
    let release!: () => void;
    let entered!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancel = vi.fn(() => {
      entered();
      return cancellation;
    });
    const target = mode === "unauthorized" ? resource : resourceMetadata;
    diagnosticFixture((url) => {
      if (url !== target) return undefined;
      return new Response(new ReadableStream({ cancel }), {
        status:
          mode === "unauthorized" ? 401 : mode === "http-error" ? 503 : 200,
        headers:
          mode === "unauthorized"
            ? {
                "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}"`,
              }
            : { "Content-Type": "application/json", "Content-Length": "16385" },
      });
    });
    const pending = diagnoseMcpEndpoint(resource);
    try {
      await started;
      await vi.advanceTimersByTimeAsync(8000);
      const result = await pending;
      const index = mode === "unauthorized" ? 2 : 0;
      expect(result.checks[index]).toMatchObject({
        passed: false,
        message: expect.stringContaining("8초"),
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      await cancellation;
    }
  },
);
