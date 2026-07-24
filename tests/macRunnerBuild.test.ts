import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

type RunOptions = {
  captureOutput?: boolean;
  input?: string;
};

type RunCommand = (
  command: string,
  args: string[],
  options?: RunOptions,
) => string;

type MetalBuildPlan = Array<{
  id: string;
  manifestPath: string;
  binaryPath: string;
  build: { command: "cargo"; args: string[] };
  capabilities: { command: string; args: ["--capabilities"] };
  expectedModels: string[];
  protocolSmoke?: {
    command: string;
    args: ["--protocol-smoke"];
    input: string;
  };
}>;

const { createMetalRunnerBuildPlan } =
  require("../scripts/metal-runner-build-plan.cjs") as {
    createMetalRunnerBuildPlan: (root: string) => MetalBuildPlan;
  };
const { createCommandRunner, executeMetalRunnerBuildPlan, parseRunnerJson } =
  require("../scripts/build-mac-runners.cjs") as {
    createCommandRunner: (options?: {
      cwd?: string;
      environment?: NodeJS.ProcessEnv;
    }) => RunCommand;
    executeMetalRunnerBuildPlan: (
      plan: MetalBuildPlan,
      run: RunCommand,
    ) => void;
    parseRunnerJson: (output: string, label: string) => unknown;
  };

describe("macOS runner build execution", () => {
  it("captures stdout when a runtime contract is requested", () => {
    const run = createCommandRunner({ cwd: process.cwd() });
    const output = run(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({ ok: true }))"],
      { captureOutput: true },
    );

    expect(parseRunnerJson(output, "fixture")).toEqual({ ok: true });
  });

  it("inherits build output but captures and validates runtime JSON", () => {
    const plan = createMetalRunnerBuildPlan(process.cwd());
    const calls: Array<{
      command: string;
      args: string[];
      options: RunOptions;
    }> = [];
    const run: RunCommand = (command, args, options = {}) => {
      calls.push({ command, args, options });
      const entry = plan.find((candidate) => candidate.binaryPath === command);
      if (!entry) {
        return "";
      }
      if (args[0] === "--capabilities") {
        return JSON.stringify({
          protocol_version: 1,
          runner: entry.id,
          backend: "metal-native",
          metal_device: true,
          models: entry.expectedModels,
        });
      }
      return JSON.stringify({
        protocol_version: 1,
        runner: entry.id,
        backend: "metal-native",
        request: "shutdown",
        ok: true,
      });
    };

    executeMetalRunnerBuildPlan(plan, run);

    expect(
      calls.map(({ args, options }) => ({
        operation: args[0],
        captureOutput: options.captureOutput ?? false,
        input: options.input,
      })),
    ).toEqual([
      { operation: "build", captureOutput: false, input: undefined },
      {
        operation: "--capabilities",
        captureOutput: true,
        input: undefined,
      },
      { operation: "build", captureOutput: false, input: undefined },
      {
        operation: "--capabilities",
        captureOutput: true,
        input: undefined,
      },
      {
        operation: "--protocol-smoke",
        captureOutput: true,
        input: '{"type":"shutdown"}\n',
      },
    ]);
  });

  it("rejects missing, malformed, and incompatible capability output", () => {
    expect(() => parseRunnerJson("", "capabilities")).toThrow(
      "capabilities did not produce JSON output",
    );
    expect(() => parseRunnerJson("not-json", "capabilities")).toThrow(
      "capabilities produced invalid JSON",
    );

    const plan = createMetalRunnerBuildPlan(process.cwd());
    const invalidRun: RunCommand = (_command, args) =>
      args[0] === "build"
        ? ""
        : JSON.stringify({
            protocol_version: 1,
            runner: plan[0].id,
            backend: "cpu",
            metal_device: false,
            models: plan[0].expectedModels,
          });

    expect(() => executeMetalRunnerBuildPlan([plan[0]], invalidRun)).toThrow(
      "Invalid Metal capability contract",
    );
  });
});
