import { describe, expect, it } from "vitest";

type WorkerRun = {
  coverageDigest?: string;
  durationMs: number;
  exitCode: number;
  iteration: number;
  testCounts?: Record<string, number>;
  testDigest?: string;
  resourceLimit: number;
  resourceSafe: boolean;
  workers: number;
};

type ProfileModule = {
  buildProfileRecord(options: { binding: object; runs: WorkerRun[] }): unknown;
  isValidatedProfile(profile: unknown, binding: object): boolean;
  parseLocalWorkerCount(value: string, resourceLimit?: number): number;
  resolveResourceAwareDefault(system: {
    logicalCpuCount: number;
    freeMemory: number;
  }): number;
  resolveVitestMaxWorkers(options: {
    binding?: object;
    env?: Record<string, string | undefined>;
    platform?: string;
    profile?: unknown;
    system?: {
      logicalCpuCount: number;
      freeMemory?: number;
      totalMemory?: number;
    };
  }): number;
};

type SoakModule = {
  digestTestReport(report: Record<string, unknown>): string;
  workerOrderForIteration(iteration: number): number[];
};

const profileModule =
  require("../scripts/vitest-worker-profile.cjs") as ProfileModule;
const soakModule = require("../scripts/soak-vitest-workers.cjs") as SoakModule;
const binding = {
  machineSha256: "machine",
  nodeVersion: "24.0.0",
  toolchainSha256: "toolchain",
};

describe("Vitest worker selection", () => {
  it("selects a resource-aware default capped at twelve workers", () => {
    const gibibyte = 1024 ** 3;
    expect(
      profileModule.resolveResourceAwareDefault({
        logicalCpuCount: 32,
        freeMemory: 64 * gibibyte,
      }),
    ).toBe(12);
    expect(
      profileModule.resolveVitestMaxWorkers({
        env: { CI: "true" },
        system: {
          logicalCpuCount: 16,
          freeMemory: 32 * gibibyte,
        },
      }),
    ).toBe(8);
    expect(
      profileModule.resolveVitestMaxWorkers({
        env: {},
        system: {
          logicalCpuCount: 8,
          freeMemory: 16 * gibibyte,
        },
      }),
    ).toBe(4);
  });

  it("permits any explicit integer from one through the safe limit", () => {
    const gibibyte = 1024 ** 3;
    expect(profileModule.parseLocalWorkerCount("1", 16)).toBe(1);
    expect(profileModule.parseLocalWorkerCount("16", 16)).toBe(16);
    expect(() => profileModule.parseLocalWorkerCount("17", 16)).toThrow(
      /1 to 16/,
    );
    expect(() => profileModule.parseLocalWorkerCount("6.5", 16)).toThrow(
      /integer/,
    );
    expect(
      profileModule.resolveVitestMaxWorkers({
        env: { MGT_VITEST_MAX_WORKERS: "16" },
        platform: "win32",
        system: {
          logicalCpuCount: 32,
          freeMemory: 64 * gibibyte,
        },
      }),
    ).toBe(16);
    expect(() =>
      profileModule.resolveVitestMaxWorkers({
        env: { MGT_VITEST_MAX_WORKERS: "16" },
        system: {
          logicalCpuCount: 8,
          freeMemory: 64 * gibibyte,
        },
      }),
    ).toThrow(/1 to 8/);
  });

  it("keeps validated profiles advisory to the resource-aware default", () => {
    const profile = profileModule.buildProfileRecord({
      binding,
      runs: profileRuns({ 4: 150, 12: 100, 16: 80 }),
    });
    expect(profileModule.isValidatedProfile(profile, binding)).toBe(true);
    expect(
      profileModule.resolveVitestMaxWorkers({
        binding,
        env: {},
        platform: "win32",
        profile,
        system: { logicalCpuCount: 16, totalMemory: 32 * 1024 ** 3 },
      }),
    ).toBe(8);
    expect(
      profileModule.resolveVitestMaxWorkers({
        binding: { ...binding, toolchainSha256: "changed" },
        env: {},
        platform: "win32",
        profile,
        system: { logicalCpuCount: 16, totalMemory: 32 * 1024 ** 3 },
      }),
    ).toBe(8);
    expect(
      profileModule.resolveVitestMaxWorkers({
        binding,
        env: {},
        platform: "win32",
        profile: {
          ...(profile as object),
          activationEligible: true,
          selectedWorkers: 16,
        },
        system: { logicalCpuCount: 64, totalMemory: 128 * 1024 ** 3 },
      }),
    ).toBe(12);
    expect(
      profileModule.resolveVitestMaxWorkers({
        binding,
        env: {},
        platform: "win32",
        profile,
        system: { logicalCpuCount: 15, totalMemory: 64 * 1024 ** 3 },
      }),
    ).toBe(7);
  });

  it("recommends sixteen only when it clears the p50 and p95 threshold", () => {
    const profile = profileModule.buildProfileRecord({
      binding,
      runs: profileRuns({ 4: 150, 12: 100, 16: 85 }),
    }) as { selectedWorkers: number };
    expect(profile.selectedWorkers).toBe(16);

    const lowerOnly = profileModule.buildProfileRecord({
      binding,
      runs: profileRuns({ 4: 50, 12: 100, 16: 100 }),
    }) as { selectedWorkers: number };
    expect(lowerOnly.selectedWorkers).toBe(12);
  });

  it("rejects failures and result drift instead of optimizing around them", () => {
    const failedRuns = profileRuns({ 4: 150, 12: 100, 16: 80 });
    failedRuns[0] = { ...failedRuns[0], exitCode: 1 };
    const failed = profileModule.buildProfileRecord({
      binding,
      runs: failedRuns,
    });
    expect(profileModule.isValidatedProfile(failed, binding)).toBe(false);

    const driftRuns = profileRuns({ 4: 150, 12: 100, 16: 80 });
    const finalRun = driftRuns.at(-1);
    if (!finalRun) throw new Error("Expected generated profile runs.");
    finalRun.coverageDigest = "different";
    const drifted = profileModule.buildProfileRecord({
      binding,
      runs: driftRuns,
    });
    expect(profileModule.isValidatedProfile(drifted, binding)).toBe(false);
  });

  it("rotates soak order to avoid consistently favoring a warm candidate", () => {
    expect(soakModule.workerOrderForIteration(1)).toEqual([4, 12, 16]);
    expect(soakModule.workerOrderForIteration(2)).toEqual([12, 16, 4]);
    expect(soakModule.workerOrderForIteration(3)).toEqual([16, 4, 12]);
    expect(soakModule.workerOrderForIteration(4)).toEqual([4, 12, 16]);
    expect(() => soakModule.workerOrderForIteration(0)).toThrow(
      /positive integer/,
    );

    const report = testReport([
      {
        file: "C:/workspace/tests/first.test.ts",
        fullName: "suite keeps the contract",
        status: "passed",
      },
      {
        file: "C:/workspace/tests/second.test.ts",
        fullName: "suite reports pending work",
        status: "pending",
      },
    ]);
    const reordered = testReport([
      {
        file: "C:/workspace/tests/second.test.ts",
        fullName: "suite reports pending work",
        status: "pending",
      },
      {
        file: "C:/workspace/tests/first.test.ts",
        fullName: "suite keeps the contract",
        status: "passed",
      },
    ]);

    expect(soakModule.digestTestReport(reordered)).toBe(
      soakModule.digestTestReport(report),
    );
    expect(
      soakModule.digestTestReport(
        testReport([
          {
            file: "C:/workspace/tests/moved.test.ts",
            fullName: "suite keeps the contract",
            status: "passed",
          },
          {
            file: "C:/workspace/tests/second.test.ts",
            fullName: "suite reports pending work",
            status: "pending",
          },
        ]),
      ),
    ).not.toBe(soakModule.digestTestReport(report));
  });
});

function testReport(
  tests: Array<{ file: string; fullName: string; status: string }>,
): Record<string, unknown> {
  return {
    numTotalTestSuites: tests.length,
    numPassedTestSuites: tests.filter((test) => test.status === "passed")
      .length,
    numFailedTestSuites: 0,
    numPendingTestSuites: tests.filter((test) => test.status === "pending")
      .length,
    numTotalTests: tests.length,
    numPassedTests: tests.filter((test) => test.status === "passed").length,
    numFailedTests: 0,
    numPendingTests: tests.filter((test) => test.status === "pending").length,
    numTodoTests: 0,
    testResults: tests.map((test) => ({
      name: test.file,
      assertionResults: [
        {
          fullName: test.fullName,
          status: test.status,
          duration: 123,
        },
      ],
    })),
  };
}

function profileRuns(durations: Record<number, number>): WorkerRun[] {
  return [4, 12, 16].flatMap((workers) =>
    Array.from({ length: 10 }, (_, index) => ({
      workers,
      iteration: index + 1,
      durationMs: durations[workers],
      exitCode: 0,
      testCounts: { total: 100, passed: 100 },
      testDigest: "tests",
      coverageDigest: "coverage",
      resourceLimit: 16,
      resourceSafe: true,
    })),
  );
}
