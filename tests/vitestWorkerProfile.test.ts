import { describe, expect, it } from "vitest";

type WorkerRun = {
  coverageDigest?: string;
  durationMs: number;
  exitCode: number;
  iteration: number;
  testCounts?: Record<string, number>;
  testDigest?: string;
  workers: number;
};

type ProfileModule = {
  buildProfileRecord(options: { binding: object; runs: WorkerRun[] }): unknown;
  isValidatedProfile(profile: unknown, binding: object): boolean;
  parseLocalWorkerCount(value: string): number;
  resolveVitestMaxWorkers(options: {
    binding?: object;
    env?: Record<string, string | undefined>;
    platform?: string;
    profile?: unknown;
    system?: { logicalCpuCount: number; totalMemory: number };
  }): number;
};

type SoakModule = {
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
  it("keeps the default and every CI run at four workers", () => {
    expect(
      profileModule.resolveVitestMaxWorkers({
        env: {},
        platform: "linux",
      }),
    ).toBe(4);
    expect(
      profileModule.resolveVitestMaxWorkers({
        env: { CI: "true", MGT_VITEST_MAX_WORKERS: "4" },
      }),
    ).toBe(4);
    expect(
      profileModule.resolveVitestMaxWorkers({
        env: { CI: "true", MGT_VITEST_MAX_WORKERS: "8" },
      }),
    ).toBe(4);
  });

  it("permits only a bounded explicit local override", () => {
    expect(profileModule.parseLocalWorkerCount("4")).toBe(4);
    expect(profileModule.parseLocalWorkerCount("8")).toBe(8);
    expect(() => profileModule.parseLocalWorkerCount("1")).toThrow(
      /4, 6, or 8/,
    );
    expect(() => profileModule.parseLocalWorkerCount("16")).toThrow(
      /4, 6, or 8/,
    );
    expect(
      profileModule.resolveVitestMaxWorkers({
        env: { MGT_VITEST_MAX_WORKERS: "6" },
        platform: "win32",
      }),
    ).toBe(6);
  });

  it("keeps validated profiles advisory until resource safety is measured", () => {
    const profile = profileModule.buildProfileRecord({
      binding,
      runs: profileRuns({ 4: 100, 6: 92, 8: 80 }),
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
    ).toBe(4);
    expect(
      profileModule.resolveVitestMaxWorkers({
        binding: { ...binding, toolchainSha256: "changed" },
        env: {},
        platform: "win32",
        profile,
        system: { logicalCpuCount: 16, totalMemory: 32 * 1024 ** 3 },
      }),
    ).toBe(4);
    expect(
      profileModule.resolveVitestMaxWorkers({
        binding,
        env: {},
        platform: "win32",
        profile: {
          ...(profile as object),
          activationEligible: true,
          selectedWorkers: 8,
        },
        system: { logicalCpuCount: 64, totalMemory: 128 * 1024 ** 3 },
      }),
    ).toBe(4);
    expect(
      profileModule.resolveVitestMaxWorkers({
        binding,
        env: {},
        platform: "win32",
        profile,
        system: { logicalCpuCount: 15, totalMemory: 64 * 1024 ** 3 },
      }),
    ).toBe(4);
  });

  it("prefers six workers when its p95 is within five percent of eight", () => {
    const profile = profileModule.buildProfileRecord({
      binding,
      runs: profileRuns({ 4: 100, 6: 84, 8: 80 }),
    }) as { selectedWorkers: number };
    expect(profile.selectedWorkers).toBe(6);
  });

  it("rejects failures and result drift instead of optimizing around them", () => {
    const failedRuns = profileRuns({ 4: 100, 6: 80, 8: 70 });
    failedRuns[0] = { ...failedRuns[0], exitCode: 1 };
    const failed = profileModule.buildProfileRecord({
      binding,
      runs: failedRuns,
    });
    expect(profileModule.isValidatedProfile(failed, binding)).toBe(false);

    const driftRuns = profileRuns({ 4: 100, 6: 80, 8: 70 });
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
    expect(soakModule.workerOrderForIteration(1)).toEqual([4, 6, 8]);
    expect(soakModule.workerOrderForIteration(2)).toEqual([6, 8, 4]);
    expect(soakModule.workerOrderForIteration(3)).toEqual([8, 4, 6]);
    expect(soakModule.workerOrderForIteration(4)).toEqual([4, 6, 8]);
    expect(() => soakModule.workerOrderForIteration(0)).toThrow(
      /positive integer/,
    );
  });
});

function profileRuns(durations: Record<number, number>): WorkerRun[] {
  return [4, 6, 8].flatMap((workers) =>
    Array.from({ length: 10 }, (_, index) => ({
      workers,
      iteration: index + 1,
      durationMs: durations[workers],
      exitCode: 0,
      testCounts: { total: 100, passed: 100 },
      testDigest: "tests",
      coverageDigest: "coverage",
    })),
  );
}
