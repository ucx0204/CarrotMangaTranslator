import { describe, expect, it, vi } from "vitest";
import {
  HttpRequestDeadlineError,
  HttpResponseTooLargeError,
  createLinkedDeadlineController,
  readBoundedResponseText,
} from "../src/main/httpResponseBudget";

describe("HTTP response budgets", () => {
  it("accepts an exact byte boundary", async () => {
    const response = new Response(new Uint8Array(8));
    await expect(
      readBoundedResponseText(response, { label: "test", maximumBytes: 8 }),
    ).resolves.toBe("\0".repeat(8));
  });

  it("rejects one byte over and cancels the reader", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(5));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readBoundedResponseText(new Response(body), {
        label: "test",
        maximumBytes: 8,
      }),
    ).rejects.toMatchObject({
      name: "HttpResponseTooLargeError",
      code: "HTTP_RESPONSE_TOO_LARGE",
      responseBudgetExceeded: true,
      nonRetriable: true,
    });
    expect(cancelled).toBe(true);
  });

  it("rejects oversized identity Content-Length before pulling the body", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulls += 1;
      },
    });
    await expect(
      readBoundedResponseText(
        new Response(body, { headers: { "content-length": "100" } }),
        { label: "test", maximumBytes: 8 },
      ),
    ).rejects.toBeInstanceOf(HttpResponseTooLargeError);
    expect(pulls).toBe(0);
  });

  it("counts streamed bytes when Content-Length is missing or compressed", async () => {
    const response = new Response(new Uint8Array(9), {
      headers: { "content-encoding": "gzip", "content-length": "3" },
    });
    await expect(
      readBoundedResponseText(response, { label: "test", maximumBytes: 8 }),
    ).rejects.toBeInstanceOf(HttpResponseTooLargeError);
  });

  it.each(["NaN", "-1", "1.5", "9007199254740992"])(
    "falls back to stream counting for invalid Content-Length %s",
    async (value) => {
      await expect(
        readBoundedResponseText(
          new Response(new Uint8Array(9), {
            headers: { "content-length": value },
          }),
          { label: "test", maximumBytes: 8 },
        ),
      ).rejects.toBeInstanceOf(HttpResponseTooLargeError);
    },
  );

  it("counts UTF-8 bytes rather than JavaScript characters", async () => {
    const response = new Response("한글");
    await expect(
      readBoundedResponseText(response, { label: "test", maximumBytes: 6 }),
    ).resolves.toBe("한글");
    await expect(
      readBoundedResponseText(new Response("한글"), {
        label: "test",
        maximumBytes: 5,
      }),
    ).rejects.toBeInstanceOf(HttpResponseTooLargeError);
  });

  it("preserves a parent abort reason and distinguishes deadline expiry", async () => {
    const parent = new AbortController();
    const parentReason = new DOMException("cancelled", "AbortError");
    const linked = createLinkedDeadlineController(
      parent.signal,
      10_000,
      "test",
    );
    parent.abort(parentReason);
    expect(linked.signal.reason).toBe(parentReason);
    linked.cleanup();

    vi.useFakeTimers();
    try {
      const deadline = createLinkedDeadlineController(null, 50, "test");
      await vi.advanceTimersByTimeAsync(50);
      expect(deadline.signal.reason).toBeInstanceOf(HttpRequestDeadlineError);
      expect(deadline.signal.reason).toMatchObject({
        code: "HTTP_REQUEST_DEADLINE_EXCEEDED",
        requestDeadlineExceeded: true,
        nonRetriable: true,
      });
      deadline.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });
});
