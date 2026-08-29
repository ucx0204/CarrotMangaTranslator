import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLaunchArgs,
  createTempDir,
} from "./helpers/runtimeModelContracts";
import { capGemmaResearchReasoningBudget } from "../src/main/workContextResearchGemma";

describe("Gemma runtime reasoning arguments", () => {
  it.each([
    { budget: undefined, enabled: "off", expectedBudget: "0" },
    { budget: 4_096, enabled: "on", expectedBudget: "4096" },
  ])(
    "maps reasoning budget $budget to llama-server",
    ({ budget, enabled, expectedBudget }) => {
      const localDir = createTempDir("reasoning-model-");
      const modelPath = join(localDir, "research-model.gguf");
      writeFileSync(modelPath, "model");
      const args = buildLaunchArgs({
        port: 18_180,
        fitTargetMb: 512,
        ctx: 65_536,
        batch: 32,
        ubatch: 32,
        modelSource: "local",
        localModelPath: modelPath,
        ...(budget === undefined ? {} : { gemmaReasoningBudget: budget }),
      });

      expect(pairAt(args, "-rea")).toEqual(["-rea", enabled]);
      expect(pairAt(args, "--reasoning-budget")).toEqual([
        "--reasoning-budget",
        expectedBudget,
      ]);
    },
  );

  it("reserves most of a short runtime context for evidence and JSON output", () => {
    expect(capGemmaResearchReasoningBudget(8_192, 32_768, 12_288)).toBe(3_072);
    expect(capGemmaResearchReasoningBudget(8_192, 32_768, 65_536)).toBe(8_192);
  });
});

function pairAt(args: string[], flag: string): string[] {
  return args.slice(args.indexOf(flag), args.indexOf(flag) + 2);
}
