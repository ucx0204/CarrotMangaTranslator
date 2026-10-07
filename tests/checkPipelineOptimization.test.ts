import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

type Stage = {
  id: string;
  command: string;
  args: string[];
  dependsOn: string[];
  executionClass: "parallel" | "exclusive";
};

type StageResult = {
  id: string;
  command: string;
  dependsOn: string[];
  executionClass: "parallel" | "exclusive";
  queuedMs: number;
  durationMs: number;
  startedAt: string;
  completedAt: string;
  status: "passed" | "failed";
  exitCode: number;
  logPath: string;
  logBytes: number;
};

type CheckModule = {
  calculateCriticalPathMs(stages: Stage[], results: StageResult[]): number;
  createStages(options?: {
    cold?: boolean;
    phase?: "all" | "build" | "test" | "merge";
    shard?: string;
  }): Stage[];
  parseArguments(args: string[]): { phase: string; shard?: string };
  nodeStage(
    id: string,
    args: string[],
    options?: {
      dependsOn?: string[];
      executionClass?: "parallel" | "exclusive";
    },
  ): Stage;
  readStageMetadata(
    logPath: string,
    expectedStageId?: string,
  ): Record<string, unknown>;
  resolveCheckParallelism(system: {
    availableCpuCount: number;
    freeMemory: number;
  }): number;
  runStageGraph(
    stages: Stage[],
    options: {
      maxParallel: number;
      run: (
        stage: Stage,
        options: { queuedMs: number },
      ) => Promise<StageResult>;
    },
  ): Promise<StageResult[]>;
  validateStages(stages: Stage[]): Stage[];
};

type CompileElectronModule = {
  assertRealGeneratedPath(
    root: string,
    candidate: string,
    options?: {
      exists(path: string): boolean;
      lstat(path: string): { isSymbolicLink(): boolean };
    },
  ): void;
  electronTypeScriptArguments(options: { noCheck: boolean }): string[];
  parseArguments(args: string[]): { noCheck: boolean };
};

const check = require("../scripts/check.cjs") as CheckModule;
const compileElectron =
  require("../scripts/compile-electron.cjs") as CompileElectronModule;

type ShardReceipt = {
  index: number;
  count: number;
  commit: string;
  platform: string;
  arch: string;
  blobSha256: string;
  files: string[];
};
const { validateShardReceipts } =
  require("../scripts/check-test-shards.cjs") as {
    validateShardReceipts(
      receipts: ShardReceipt[],
      files: string[],
      binding: { commit: string; platform: string; arch: string },
    ): number;
  };

describe("distributed Check completeness", () => {
  it("partitions the full gate inventory while keeping build typechecks and merged coverage mandatory", () => {
    const build = check.validateStages(check.createStages({ phase: "build" }));
    const test = check.validateStages(
      check.createStages({ phase: "test", shard: "1/4" }),
    );
    const merge = check.validateStages(check.createStages({ phase: "merge" }));
    const ids = (stages: Stage[]) => stages.map((stage) => stage.id);
    expect([...new Set(ids([...build, ...test, ...merge]))].sort()).toEqual(
      ids(check.createStages()).sort(),
    );
    expect(build.find((stage) => stage.id === "build")?.dependsOn).toEqual(
      expect.arrayContaining([
        "typecheck",
        "typecheck-electron",
        "typecheck-js",
      ]),
    );
    expect(ids(test)).toEqual([
      "private-workspace",
      "prepare-electron",
      "prepare-ffmpeg",
      "prepare-import-source-runner",
      "test-coverage",
    ]);
    expect(
      merge.find((stage) => stage.id === "production-cleanup-coverage")
        ?.dependsOn,
    ).toEqual(["test-coverage"]);
    expect(merge.find((stage) => stage.id === "test-coverage")?.args).toEqual(
      expect.arrayContaining(["merge"]),
    );
    for (const args of [
      ["--phase=test"],
      ["--shard=1/4"],
      ["--phase=test", "--shard=0/4"],
      ["--phase=test", "--shard=1/3"],
      ["--phase=merge", "--shard=1/4"],
    ]) {
      expect(() => check.parseArguments(args)).toThrow();
    }
    expect(check.parseArguments(["--phase=test", "--shard=4/4"])).toMatchObject(
      { phase: "test", shard: "4/4" },
    );
  });

  const binding = { commit: "candidate-sha", platform: "win32", arch: "x64" };
  const receipts = (): ShardReceipt[] =>
    [1, 2, 3, 4].map((index) => ({
      index,
      count: 4,
      ...binding,
      blobSha256: "a".repeat(64),
      files: [`tests/${index}.test.ts`],
    }));
  const inventory = [1, 2, 3, 4].map((index) => `tests/${index}.test.ts`);

  it("accepts all files exactly once in any receipt order", () => {
    expect(
      validateShardReceipts(receipts().reverse(), inventory, binding),
    ).toBe(4);
  });

  it.each([
    ["missing shard", (rows: ShardReceipt[]) => rows.pop()],
    [
      "duplicate shard",
      (rows: ShardReceipt[]) => {
        rows[3].index = 1;
      },
    ],
    [
      "duplicate file",
      (rows: ShardReceipt[]) => {
        rows[3].files = rows[0].files;
      },
    ],
    [
      "missing/new file",
      (rows: ShardReceipt[]) => {
        rows[3].files = ["tests/extra.test.ts"];
      },
    ],
    [
      "stale commit",
      (rows: ShardReceipt[]) => {
        rows[3].commit = "older-sha";
      },
    ],
    [
      "wrong platform",
      (rows: ShardReceipt[]) => {
        rows[3].platform = "darwin";
      },
    ],
    [
      "wrong architecture",
      (rows: ShardReceipt[]) => {
        rows[3].arch = "arm64";
      },
    ],
  ] as const)(
    "rejects %s instead of passing an incomplete check",
    (_name, mutate) => {
      const rows = receipts();
      mutate(rows);
      expect(() => validateShardReceipts(rows, inventory, binding)).toThrow();
    },
  );

  it("keeps the existing required job names gated on both build and all four test runners", () => {
    const workflow = parseYaml(
      readFileSync(join(process.cwd(), ".github/workflows/check.yml"), "utf8"),
    );
    for (const prefix of ["windows", "macos-arm64"]) {
      const gate = workflow.jobs[`${prefix}-check`];
      expect(gate.needs).toEqual([`${prefix}-build`, `${prefix}-tests`]);
      expect(gate.if).toBe("always()");
      expect(gate.steps[0].env).toEqual({
        BUILD_RESULT: `\${{ needs.${prefix}-build.result }}`,
        TEST_RESULT: `\${{ needs.${prefix}-tests.result }}`,
      });
      expect(gate.steps[0].run).toContain(
        'test "$BUILD_RESULT" = success && test "$TEST_RESULT" = success',
      );
      const tests = workflow.jobs[`${prefix}-tests`];
      expect(tests.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
      expect(tests.strategy["fail-fast"]).toBe(false);
      expect(tests.needs).toBeUndefined();
    }
    expect(workflow.jobs["macos-arm64-tests"].env.MGT_VITEST_MAX_WORKERS).toBe(
      "1",
    );
  });
});

describe("check DAG", () => {
  it("keeps all 27 gates and their production ordering constraints", () => {
    const stages = check.createStages();
    expect(stages.map((stage) => stage.id)).toEqual([
      "private-workspace",
      "typecheck",
      "typecheck-electron",
      "typecheck-js",
      "format",
      "lint",
      "error-handling",
      "test-mock-boundaries",
      "architecture",
      "maintainability-policy",
      "duplicates",
      "reexports",
      "generated",
      "css-structure",
      "script-entrypoints",
      "deadcode",
      "deadcode-exports",
      "prepare-electron",
      "prepare-ffmpeg",
      "prepare-import-source-runner",
      "test-coverage",
      "production-cleanup-coverage",
      "build",
      "page-artwork-parity",
      "image-protocol-smoke",
      "renderer-bundle",
      "preload-bundle",
    ]);
    expect(stages.every((stage) => stage.command === process.execPath)).toBe(
      true,
    );
    expect(
      stages.some((stage) =>
        [stage.command, ...stage.args].some((argument) =>
          /(?:^|[\\/])npm(?:-cli\.js|\.cmd)?$/iu.test(argument),
        ),
      ),
    ).toBe(false);

    const preflight = stages.slice(1, 20);
    expect(
      preflight.every(
        (stage) =>
          stage.executionClass === "parallel" &&
          JSON.stringify(stage.dependsOn) ===
            JSON.stringify(["private-workspace"]),
      ),
    ).toBe(true);
    expect(stages[20]).toMatchObject({
      id: "test-coverage",
      executionClass: "exclusive",
      dependsOn: preflight.map((stage) => stage.id),
    });
    expect(stages[21].dependsOn).toEqual(["test-coverage"]);
    expect(stages[22]).toMatchObject({
      id: "build",
      dependsOn: ["production-cleanup-coverage"],
    });
    expect(
      stages.slice(23).every((stage) => stage.dependsOn[0] === "build"),
    ).toBe(true);
  });

  it("uses machine-readable Vitest results and verified build reuse", () => {
    const stages = check.createStages();
    const coverage = stages.find((stage) => stage.id === "test-coverage");
    expect(coverage?.args).toEqual(
      expect.arrayContaining([
        "run",
        "--coverage",
        "--reporter=default",
        "--reporter=json",
        expect.stringMatching(/^--outputFile\.json=/u),
      ]),
    );
    expect(stages.find((stage) => stage.id === "build")?.args).toContain(
      "--reuse-verified-outputs",
    );
    expect(
      check.createStages({ cold: true }).find((stage) => stage.id === "build")
        ?.args,
    ).not.toContain("--reuse-verified-outputs");
    expect(
      check.createStages({ cold: true }).find((stage) => stage.id === "lint")
        ?.args,
    ).not.toContain("--cache");
    expect(
      check
        .createStages({ cold: true })
        .find((stage) => stage.id === "typecheck")?.args,
    ).toEqual(expect.arrayContaining(["--incremental", "false"]));
  });

  it("bounds static parallelism by CPU and free memory", () => {
    const gibibyte = 1024 ** 3;
    expect(
      check.resolveCheckParallelism({
        availableCpuCount: 32,
        freeMemory: 64 * gibibyte,
      }),
    ).toBe(4);
    expect(
      check.resolveCheckParallelism({
        availableCpuCount: 8,
        freeMemory: 64 * gibibyte,
      }),
    ).toBe(2);
    expect(
      check.resolveCheckParallelism({
        availableCpuCount: 32,
        freeMemory: gibibyte,
      }),
    ).toBe(1);
  });

  it("rejects missing dependencies and cycles before starting commands", () => {
    expect(() => check.validateStages([stage("a", ["missing"])])).toThrow(
      /missing stage/,
    );
    expect(() =>
      check.validateStages([stage("a", ["b"]), stage("b", ["a"])]),
    ).toThrow(/cycle/);
  });

  it("rejects duplicate IDs and unknown execution classes", () => {
    expect(() =>
      check.validateStages([stage("same", []), stage("same", [])]),
    ).toThrow(/Duplicate/);
    const invalid = stage("invalid", []);
    Reflect.set(invalid, "executionClass", "background");
    expect(() => check.validateStages([invalid])).toThrow(/execution class/);
  });

  it("computes the dependency critical path rather than summing peers", () => {
    const stages = [
      stage("seal", ["left", "right"], "exclusive"),
      stage("right", ["root"]),
      stage("root", [], "exclusive"),
      stage("left", ["root"]),
    ];
    const durations = new Map([
      ["root", 2],
      ["left", 5],
      ["right", 3],
      ["seal", 7],
    ]);
    const results = stages.map((current) => ({
      ...result(current),
      durationMs: durations.get(current.id) ?? 0,
    }));
    expect(check.calculateCriticalPathMs(stages, results)).toBe(14);
  });

  it("accepts metadata only from the stage that owns the log", () => {
    const directory = mkdtempSync(join(tmpdir(), "manga-check-meta-"));
    const logPath = join(directory, "test.log");
    try {
      writeFileSync(
        logPath,
        [
          '[check-metadata] {"stage":"format","cacheHit":false}',
          '[check-metadata] {"stage":"build","cacheHit":true}',
        ].join("\n"),
      );
      expect(check.readStageMetadata(logPath, "test-coverage")).toEqual({});
      expect(check.readStageMetadata(logPath, "build")).toEqual({
        stage: "build",
        cacheHit: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates an extensible stage descriptor with safe defaults", () => {
    expect(check.nodeStage("example", ["script.cjs"])).toEqual({
      id: "example",
      command: process.execPath,
      args: ["script.cjs"],
      dependsOn: [],
      executionClass: "parallel",
    });
  });

  it("runs independent stages concurrently but keeps exclusive stages alone", async () => {
    const stages = [
      stage("root", [], "exclusive"),
      stage("left", ["root"]),
      stage("right", ["root"]),
      stage("queued", ["root"]),
      stage("seal", ["left", "right", "queued"], "exclusive"),
    ];
    let active = 0;
    let maximumActive = 0;
    const activeWhenStarted = new Map<string, number>();
    const results = await check.runStageGraph(stages, {
      maxParallel: 2,
      run: async (current, options) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        activeWhenStarted.set(current.id, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { ...result(current), queuedMs: options.queuedMs };
      },
    });

    expect(results.map((entry) => entry.id)).toEqual([
      "root",
      "left",
      "right",
      "queued",
      "seal",
    ]);
    expect(maximumActive).toBe(2);
    expect(activeWhenStarted.get("root")).toBe(1);
    expect(activeWhenStarted.get("seal")).toBe(1);
    expect(
      results.find((entry) => entry.id === "queued")?.queuedMs,
    ).toBeGreaterThan(5);
  });

  it("stops scheduling downstream work after a peer fails", async () => {
    const stages = [
      stage("root", [], "exclusive"),
      stage("failure", ["root"]),
      stage("peer", ["root"]),
      stage("downstream", ["failure", "peer"], "exclusive"),
    ];
    const started: string[] = [];
    const results = await check.runStageGraph(stages, {
      maxParallel: 2,
      run: async (current) => {
        started.push(current.id);
        await new Promise((resolve) =>
          setTimeout(resolve, current.id === "peer" ? 10 : 1),
        );
        return result(current, current.id === "failure" ? "failed" : "passed");
      },
    });

    expect(started).toEqual(["root", "failure", "peer"]);
    expect(results.map((entry) => entry.id)).toEqual([
      "root",
      "failure",
      "peer",
    ]);
  });
});

describe("check-only Electron noCheck emit", () => {
  it("adds noCheck only for the already-typechecked check build", () => {
    expect(compileElectron.parseArguments([])).toEqual({ noCheck: false });
    expect(compileElectron.parseArguments(["--noCheck"])).toEqual({
      noCheck: true,
    });
    expect(
      compileElectron.electronTypeScriptArguments({ noCheck: false }),
    ).toEqual(["-p", "tsconfig.electron.json"]);
    expect(
      compileElectron.electronTypeScriptArguments({ noCheck: true }),
    ).toEqual(["-p", "tsconfig.electron.json", "--noCheck"]);
    expect(() => compileElectron.parseArguments(["--skip-check"])).toThrow(
      /Unsupported compile-electron arguments/,
    );
  });
});

function stage(
  id: string,
  dependsOn: string[],
  executionClass: "parallel" | "exclusive" = "parallel",
): Stage {
  return {
    id,
    command: process.execPath,
    args: [id],
    dependsOn,
    executionClass,
  };
}

function result(
  current: Stage,
  status: "passed" | "failed" = "passed",
): StageResult {
  return {
    id: current.id,
    command: current.command,
    dependsOn: current.dependsOn,
    executionClass: current.executionClass,
    queuedMs: 0,
    durationMs: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.001Z",
    status,
    exitCode: status === "passed" ? 0 : 1,
    logPath: "",
    logBytes: 0,
  };
}
