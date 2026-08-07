import { afterEach, describe, expect, it, vi } from "vitest";

const { isReachable } =
  require("../src/main/runtime/transport/llama-server-readiness.cjs") as {
    isReachable: (baseUrl: string) => Promise<boolean>;
  };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("llama readiness response lifecycle", () => {
  it.each([
    [200, true],
    [503, false],
  ] as const)(
    "cancels an unused response body for status %s",
    async (status, expected) => {
      let cancelled = 0;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled += 1;
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status })),
      );

      await expect(isReachable("http://127.0.0.1:12345")).resolves.toBe(
        expected,
      );
      expect(cancelled).toBe(1);
    },
  );
});
