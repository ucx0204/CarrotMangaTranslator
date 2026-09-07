import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { runWithApiKeyRetry } =
  require("../src/main/runtime/transport/api-key-retry.cjs") as {
    runWithApiKeyRetry: <T>(
      options: Record<string, unknown>,
      attempt: () => Promise<T>,
    ) => Promise<T>;
  };
const { waitForApiRequestStart } =
  require("../src/main/runtime/transport/api-request-pacing.cjs") as {
    waitForApiRequestStart: (options: Record<string, unknown>) => Promise<void>;
  };
const options = () => ({
  modelProvider: "openai-api",
  apiBaseUrl: `https://${randomUUID()}.test/v1`,
  apiRequestIntervalSeconds: 0.15,
});

beforeEach(() => {
  for (const name of [
    "MANGA_TRANSLATOR_API_BASE_URL",
    "MANGA_TRANSLATOR_API_REQUEST_INTERVAL_SECONDS",
    "MANGA_TRANSLATOR_API_KEY",
    "OPENAI_API_KEY",
  ])
    vi.stubEnv(name, undefined);
});
afterEach(() => vi.unstubAllEnvs());

it("paces API calls even when the endpoint needs no key", async () => {
  const config = options();
  const starts: number[] = [];
  const attempt = vi.fn(async () => {
    starts.push(performance.now());
    return "ok";
  });
  await runWithApiKeyRetry(config, attempt);
  await runWithApiKeyRetry(config, attempt);
  expect(attempt).toHaveBeenCalledWith(
    undefined,
    expect.objectContaining({ keyCount: 0 }),
  );
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(140);
});

it("paces concurrent dispatches and retries at request start", async () => {
  const config = {
    ...options(),
    apiKey: "test",
    apiKeyMaxAttempts: 2,
    apiRetryDelaySeconds: 0,
  };
  const starts: number[] = [];
  let first = true;
  const run = () =>
    runWithApiKeyRetry(config, async () => {
      starts.push(performance.now());
      if (first) {
        first = false;
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }
      return "ok";
    });
  expect(await Promise.all([run(), run()])).toEqual(["ok", "ok"]);
  expect(starts).toHaveLength(3);
  for (let i = 1; i < starts.length; i++)
    expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(140);
});

it("counts request duration toward the interval and dispatches immediately when it has elapsed", async () => {
  const config = options();
  await waitForApiRequestStart(config);
  await delay(170);
  const start = performance.now();
  await waitForApiRequestStart(config);
  expect(performance.now() - start).toBeLessThan(100);
  await delay(80);
  const next = performance.now();
  await waitForApiRequestStart(config);
  expect(performance.now() - next).toBeLessThan(125);
});

it("cancels queued calls immediately without consuming their slots or poisoning the queue", async () => {
  const config = options();
  await waitForApiRequestStart(config);
  const waiting = waitForApiRequestStart(config);
  const controller = new AbortController();
  const cancelled = waitForApiRequestStart({
    ...config,
    abortSignal: controller.signal,
  });
  const rejection = expect(cancelled).rejects.toThrow("stop");
  controller.abort(new Error("stop"));
  await rejection;
  expect(controller.signal.aborted).toBe(true);
  await waiting;
  await waitForApiRequestStart(config);
});

it("keeps the zero default and does not couple other endpoints or local engines", async () => {
  const config = options();
  await waitForApiRequestStart(config);
  const start = performance.now();
  await Promise.all([
    waitForApiRequestStart({ ...config, apiRequestIntervalSeconds: 0 }),
    runWithApiKeyRetry(
      { ...config, modelProvider: "openai-codex" },
      async () => undefined,
    ),
    waitForApiRequestStart({
      ...config,
      apiBaseUrl: "https://independent.test/v1",
    }),
  ]);
  expect(performance.now() - start).toBeLessThan(100);
});
