import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerModel } from "../src/main/codexAppServerProtocol";
import {
  runCodexWebResearchWithFallback,
  selectCodexWebResearchFallback,
} from "../src/main/codexWebResearchFallback";

describe("Codex web-research fallback", () => {
  it("falls back from Sol to an available GPT-5.5 with the requested effort", () => {
    expect(
      selectCodexWebResearchFallback(
        [model("gpt-5.6-sol", ["low"]), model("gpt-5.5", ["low", "high"])],
        "gpt-5.6-sol",
        "low",
      ),
    ).toEqual({ model: "gpt-5.5", effort: "low" });
  });

  it("uses the fallback model default when the requested effort is unsupported", () => {
    expect(
      selectCodexWebResearchFallback(
        [model("gpt-5.5", ["low", "medium"], "medium")],
        "gpt-5.6-sol",
        "ultra",
      ),
    ).toEqual({ model: "gpt-5.5", effort: "medium" });
  });

  it("does not retry the fallback model itself or an unavailable model", () => {
    expect(
      selectCodexWebResearchFallback(
        [model("gpt-5.5", ["low"])],
        "gpt-5.5",
        "low",
      ),
    ).toBeNull();
    expect(
      selectCodexWebResearchFallback(
        [model("gpt-5.6-sol", ["low"])],
        "gpt-5.6-sol",
        "low",
      ),
    ).toBeNull();
  });

  it("can try the known fallback when model discovery returns no catalog", () => {
    expect(selectCodexWebResearchFallback([], "gpt-5.6-sol", "high")).toEqual({
      model: "gpt-5.5",
      effort: "high",
    });
  });

  it("retries a zero-search turn and reports the model substitution", async () => {
    const calls: Array<{ model: string; effort: string }> = [];
    const onFallback = vi.fn();
    const result = await runCodexWebResearchWithFallback({
      models: [model("gpt-5.5", ["low"])],
      selectedModel: "gpt-5.6-sol",
      selectedEffort: "low",
      runTurn: async (requestedModel, effort) => {
        calls.push({ model: requestedModel, effort });
        return turnResult(requestedModel === "gpt-5.5" ? 2 : 0);
      },
      onFallback,
    });

    expect(calls).toEqual([
      { model: "gpt-5.6-sol", effort: "low" },
      { model: "gpt-5.5", effort: "low" },
    ]);
    expect(onFallback).toHaveBeenCalledWith({
      model: "gpt-5.5",
      effort: "low",
    });
    expect(result.result.webSearchCount).toBe(2);
    expect(result.warnings[0]).toContain("gpt-5.5로 자동 재시도");
  });

  it("fails clearly when both selected and fallback turns cannot search", async () => {
    await expect(
      runCodexWebResearchWithFallback({
        models: [model("gpt-5.5", ["low"])],
        selectedModel: "gpt-5.6-sol",
        selectedEffort: "low",
        runTurn: async () => turnResult(0),
      }),
    ).rejects.toThrow("gpt-5.5 자동 재시도에서도 검색 도구");
  });
});

function model(
  id: string,
  supportedReasoningEfforts: string[],
  defaultReasoningEffort = supportedReasoningEfforts[0] ?? "medium",
): CodexAppServerModel {
  return {
    id,
    displayName: id,
    hidden: false,
    supportedReasoningEfforts,
    defaultReasoningEffort,
    isDefault: false,
  };
}

function turnResult(webSearchCount: number) {
  return {
    text: '{"operations":[],"warnings":[]}',
    threadId: "thread-test",
    turnId: "turn-test",
    itemId: "item-test",
    webSearchCount,
  };
}
