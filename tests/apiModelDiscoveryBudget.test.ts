import { describe, expect, it, vi } from "vitest";
import {
  fetchJsonWithKeys,
  fetchText,
} from "../src/main/apiModelDiscoveryHttp";
import {
  MAX_MODEL_DISCOVERY_HTML_BYTES,
  MAX_MODEL_DISCOVERY_JSON_BYTES,
} from "../src/main/networkBudgets";

describe("API model discovery response budgets", () => {
  it("rejects oversized JSON without rotating API keys", async () => {
    const attemptedKeys: string[] = [];
    let pulls = 0;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_input, init) => {
        attemptedKeys.push(
          new Headers(init?.headers).get("authorization") ?? "missing",
        );
        return oversizedDeclaredResponse(MAX_MODEL_DISCOVERY_JSON_BYTES, () => {
          pulls += 1;
        });
      });

    await expect(
      fetchJsonWithKeys(
        "https://provider.invalid/models",
        "key-one\nkey-two",
        (key) => ({ Authorization: `Bearer ${key}` }),
        fetchImpl,
      ),
    ).rejects.toMatchObject({
      code: "HTTP_RESPONSE_TOO_LARGE",
      responseBudgetExceeded: true,
      nonRetriable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(attemptedKeys).toEqual(["Bearer key-one"]);
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it("rejects oversized NVIDIA HTML before caller parsing", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        oversizedDeclaredResponse(MAX_MODEL_DISCOVERY_HTML_BYTES),
      );
    await expect(
      fetchText("https://catalog.invalid/models", fetchImpl, {
        maximumBytes: MAX_MODEL_DISCOVERY_HTML_BYTES,
        label: "NVIDIA model catalog",
      }),
    ).rejects.toMatchObject({
      code: "HTTP_RESPONSE_TOO_LARGE",
      responseBudgetExceeded: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps normal JSON discovery parsing unchanged", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{"data":[{"id":"model-a"}]}', { status: 200 }),
      );
    await expect(
      fetchJsonWithKeys(
        "https://provider.invalid/models",
        "key-one",
        () => ({}),
        fetchImpl,
      ),
    ).resolves.toEqual({ data: [{ id: "model-a" }] });
  });
});

function oversizedDeclaredResponse(
  maximumBytes: number,
  onPull: () => void = () => undefined,
): Response {
  const body = new ReadableStream<Uint8Array>({ pull: onPull });
  return new Response(body, {
    status: 200,
    headers: { "content-length": String(maximumBytes + 1) },
  });
}
