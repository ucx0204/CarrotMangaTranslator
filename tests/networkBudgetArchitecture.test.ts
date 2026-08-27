import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_MODEL_HTTP_RESPONSE_BYTES,
  MAX_TOKENIZE_RESPONSE_BYTES,
  MODEL_HTTP_REQUEST_DEADLINE_MS,
} from "../src/main/networkBudgets";

const cjsBudgets =
  require("../src/main/runtime/transport/network-budgets.cjs") as {
    MAX_MODEL_HTTP_RESPONSE_BYTES: number;
    MAX_TOKENIZE_RESPONSE_BYTES: number;
    MODEL_HTTP_REQUEST_DEADLINE_MS: number;
  };
const root = resolve(process.cwd(), "src/main");

describe("network budget architecture invariants", () => {
  it("keeps TS and CJS model response budgets in parity", () => {
    expect(cjsBudgets.MAX_MODEL_HTTP_RESPONSE_BYTES).toBe(
      MAX_MODEL_HTTP_RESPONSE_BYTES,
    );
    expect(cjsBudgets.MAX_TOKENIZE_RESPONSE_BYTES).toBe(
      MAX_TOKENIZE_RESPONSE_BYTES,
    );
    expect(cjsBudgets.MODEL_HTTP_REQUEST_DEADLINE_MS).toBe(
      MODEL_HTTP_REQUEST_DEADLINE_MS,
    );
  });

  it("has no unbounded Response body convenience readers in security paths", () => {
    const files = [
      "apiModelDiscoveryHttp.ts",
      "workContextModelRequest.ts",
      "codexAppServerEndpoint.ts",
      "inpainting/fluxAssets/downloads.ts",
      "runtime/transport/model-response-readers.cjs",
      "runtime/transport/download-range-request.cjs",
      "runtime/transport/download-range-body.cjs",
      "runtime/simple-page-logit-bias.cjs",
    ];
    for (const file of files) {
      expect(source(file), file).not.toMatch(
        /response\s*\.\s*(?:text|json|arrayBuffer)\s*\(/,
      );
    }
  });

  it("keeps model and download absolute deadlines wired outside retry loops", () => {
    expect(source("runtime/transport/translation-request.cjs")).toContain(
      "MODEL_HTTP_REQUEST_DEADLINE_MS",
    );
    expect(source("workContextModelRequest.ts")).toContain(
      "MODEL_HTTP_REQUEST_DEADLINE_MS",
    );
    expect(source("runtime/transport/hf-download.cjs")).toContain(
      "resolveDownloadAbsoluteTimeoutMs",
    );
    expect(source("runtime/transport/hf-download.cjs")).toMatch(
      /createDownloadDeadline[\s\S]*performDownloadRetries/,
    );
  });

  it("requires maximumBytes across the production download layers", () => {
    const files = [
      "runtimeSupport/modelDownloads.ts",
      "runtime/transport/hf-download.cjs",
      "runtime/transport/download-stream.cjs",
      "runtime/transport/download-ranges.cjs",
      "runtime/model/hf-model-download-tasks.cjs",
      "runtime/model/llama-runtime-download.cjs",
      "runtime/model/paddle-model-download.cjs",
      "runtime/ocr/managed-python.cjs",
      "runtime/ocr/managed-vcredist.cjs",
      "inpainting/fluxAssets/downloads.ts",
    ];
    for (const file of files) {
      expect(source(file), file).toContain("maximumBytes");
    }
  });

  it("keeps exact pinned asset callers on exact expected and maximum sizes", () => {
    for (const file of [
      "bubbleLayout/assets.ts",
      "textDetection/animeTextAssets.ts",
      "pipeline/fontMatchingRuntimeAssets.ts",
    ]) {
      const text = source(file);
      expect(text, file).toContain("expectedTotalBytes");
      expect(text, file).toContain("maximumBytes");
      expect(text, file).toContain("expectedSha256");
    }
    expect(source("inpainting/koharuAssets.ts")).toContain(
      "MAX_REMOTE_SUPPORT_ASSET_BYTES",
    );
    expect(source("inpainting/fluxAssets/downloads.ts")).toContain(
      "MAX_REMOTE_RUNTIME_ARCHIVE_BYTES",
    );
  });

  it("cancels unused llama readiness response bodies", () => {
    expect(source("runtime/transport/llama-server-readiness.cjs")).toMatch(
      /response\.body\?\.cancel\(\)/,
    );
  });
});

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}
