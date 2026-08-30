import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type CoverageMetricName = "lines" | "statements" | "functions" | "branches";
type CoverageMetric = {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
};
type CoverageFloorMetric = Pick<CoverageMetric, "total" | "covered" | "pct">;
type CoverageRecord = Partial<Record<CoverageMetricName, CoverageMetric>>;
type CoverageScope = { existing: string[]; added: string[]; deleted: string[] };
type CoverageManifest = {
  schemaVersion: number;
  provenance: {
    baseCommit: string;
    baselinePlatform: "win32";
    coverageProvider: string;
    sourceArtifact: string;
    sourceArtifactSha256: string;
    introducedArtifact: string;
    introducedArtifactSha256: string;
    validatedNodeV8: string[];
    vitestVersion: string;
    coverageV8Version: string;
  };
  floors: Record<
    string,
    Partial<Record<CoverageMetricName, CoverageFloorMetric>>
  >;
  introducedFloors: Record<
    string,
    Partial<Record<CoverageMetricName, CoverageFloorMetric>>
  >;
  deletedFiles: string[];
};
type CoverageGateModule = {
  CLEANUP_BASE_COMMIT: string;
  COVERAGE_METRICS: readonly CoverageMetricName[];
  checkProductionCleanupCoverage(options: {
    root: string;
    manifestPath: string;
    coveragePath: string;
    platform: NodeJS.Platform | string;
    collectScope?: (root: string, baseCommit: string) => CoverageScope;
  }): {
    baselinePlatform: string;
    comparedFloors: boolean;
    floorFiles: number;
    introducedFloorFiles: number;
    deletedFiles: number;
  };
  collectCoverageScope(root: string, baseCommit: string): CoverageScope;
  parseCoverageStatusOutput(
    diffOutput: string,
    untrackedOutput: string,
  ): CoverageScope;
  loadCoverageManifest(root: string, manifestPath: string): CoverageManifest;
};

const gate =
  require("../scripts/check-production-cleanup-coverage.cjs") as CoverageGateModule;
const repositoryRoot = join(__dirname, "..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("production cleanup coverage floor gate", () => {
  it("accepts complete records at the sealed Windows floors", () => {
    const fixture = createFixture();

    expect(runGate(fixture, "win32")).toEqual({
      baselinePlatform: "win32",
      comparedFloors: true,
      floorFiles: 1,
      introducedFloorFiles: 1,
      deletedFiles: 0,
    });
  });

  it.each(gate.COVERAGE_METRICS)(
    "fails closed when the %s floor regresses",
    (metric) => {
      const fixture = createFixture();
      fixture.coverage[fixture.existingFileAbsolute][metric] =
        coverageMetric(79);
      fixture.writeCoverage();

      expect(() => runGate(fixture, "win32")).toThrow(
        new RegExp(`${metric}: 79% \\(79/100\\) below exact baseline`, "u"),
      );
    },
  );

  it("compares exact ratios when both displayed percentages round the same", () => {
    const fixture = createFixture();
    fixture.manifest.floors[fixture.existingFile].branches =
      coverageFloorMetric(2, 3);
    fixture.coverage[fixture.existingFileAbsolute].branches = coverageMetric(
      4,
      6,
    );
    fixture.writeManifest();
    fixture.writeCoverage();
    expect(() => runGate(fixture, "win32")).not.toThrow();

    fixture.coverage[fixture.existingFileAbsolute].branches = coverageMetric(
      6_666,
      10_000,
    );
    fixture.writeCoverage();
    expect(() => runGate(fixture, "win32")).toThrow(
      /66\.66% \(6666\/10000\) below exact baseline 66\.66% \(2\/3\)/u,
    );
  });

  it("accepts Istanbul's exact integer percentage at a floating-point boundary", () => {
    const fixture = createFixture();
    fixture.manifest.floors[fixture.existingFile].lines = {
      total: 100,
      covered: 57,
      pct: 57,
    };
    fixture.coverage[fixture.existingFileAbsolute].lines = {
      total: 100,
      covered: 57,
      skipped: 0,
      pct: 57,
    };
    fixture.writeManifest();
    fixture.writeCoverage();

    expect(() => runGate(fixture, "win32")).not.toThrow();
  });

  it("requires full coverage when the baseline metric had no executable items", () => {
    const fixture = createFixture();
    fixture.manifest.floors[fixture.existingFile].functions =
      coverageFloorMetric(0, 0);
    fixture.coverage[fixture.existingFileAbsolute].functions = coverageMetric(
      1,
      1,
    );
    fixture.writeManifest();
    fixture.writeCoverage();
    expect(() => runGate(fixture, "win32")).not.toThrow();

    fixture.coverage[fixture.existingFileAbsolute].functions = coverageMetric(
      0,
      1,
    );
    fixture.writeCoverage();
    expect(() => runGate(fixture, "win32")).toThrow(
      /0% \(0\/1\) below exact baseline 100% \(0\/0\)/u,
    );
  });

  it("rejects a zero-total current metric when the baseline had items", () => {
    const fixture = createFixture();
    fixture.coverage[fixture.existingFileAbsolute].lines = coverageMetric(0, 0);
    fixture.writeCoverage();

    expect(() => runGate(fixture, "win32")).toThrow(
      /100% \(0\/0\) below exact baseline 80% \(80\/100\)/u,
    );
  });

  it("validates records on another platform without comparing Windows floors", () => {
    const fixture = createFixture();
    fixture.coverage[fixture.existingFileAbsolute] = coverageRecord(70);
    fixture.writeCoverage();

    expect(runGate(fixture, "darwin").comparedFloors).toBe(false);

    delete fixture.coverage[fixture.addedFileAbsolute].branches;
    fixture.writeCoverage();
    expect(() => runGate(fixture, "darwin")).toThrow(
      /missing metric branches/u,
    );
  });

  it("does not allow a Darwin manifest to replace the canonical Windows floors", () => {
    const fixture = createFixture();
    Reflect.set(fixture.manifest.provenance, "baselinePlatform", "darwin");
    fixture.writeManifest();

    expect(() => runGate(fixture, "darwin")).toThrow(
      /baselinePlatform is invalid/u,
    );
  });

  it("applies exact floors to introduced production files", () => {
    const fixture = createFixture();
    fixture.coverage[fixture.addedFileAbsolute].branches = coverageMetric(79);
    fixture.writeCoverage();

    expect(() => runGate(fixture, "win32")).toThrow(
      /src\/shared\/added\.ts branches: 79%.*below exact baseline/u,
    );
  });

  it("allows the introduced floor map to become empty when no added files remain", () => {
    const fixture = createFixture();
    fixture.manifest.introducedFloors = {};
    delete fixture.coverage[fixture.addedFileAbsolute];
    fixture.writeManifest();
    fixture.writeCoverage();

    expect(() =>
      runGate(fixture, "win32", () => ({
        existing: [fixture.existingFile],
        added: [],
        deleted: [],
      })),
    ).not.toThrow();
  });

  it("rejects missing files, metrics, and internally inconsistent percentages", () => {
    const missingFile = createFixture();
    delete missingFile.coverage[missingFile.addedFileAbsolute];
    missingFile.writeCoverage();
    expect(() => runGate(missingFile, "win32")).toThrow(
      /missing required file/u,
    );

    const missingMetric = createFixture();
    delete missingMetric.coverage[missingMetric.existingFileAbsolute].functions;
    missingMetric.writeCoverage();
    expect(() => runGate(missingMetric, "win32")).toThrow(
      /missing metric functions/u,
    );

    const inconsistent = createFixture();
    inconsistent.coverage[inconsistent.existingFileAbsolute].lines = {
      total: 100,
      covered: 79,
      skipped: 0,
      pct: 80,
    };
    inconsistent.writeCoverage();
    expect(() => runGate(inconsistent, "win32")).toThrow(
      /pct does not match its counts/u,
    );

    const overlappingSkipped = createFixture();
    overlappingSkipped.coverage[overlappingSkipped.existingFileAbsolute].lines =
      {
        total: 100,
        covered: 80,
        skipped: 30,
        pct: 80,
      };
    overlappingSkipped.writeCoverage();
    expect(() => runGate(overlappingSkipped, "win32")).toThrow(
      /Coverage metric.*is invalid/u,
    );
  });

  it("rejects missing or damaged summary and manifest inputs", () => {
    const missingSummary = createFixture();
    rmSync(missingSummary.coveragePath);
    expect(() => runGate(missingSummary, "win32")).toThrow(
      /Cannot read coverage summary/u,
    );

    const damagedSummary = createFixture();
    delete damagedSummary.coverage.total;
    damagedSummary.writeCoverage();
    expect(() => runGate(damagedSummary, "win32")).toThrow(
      /must contain a total record/u,
    );

    const missingManifest = createFixture();
    rmSync(missingManifest.manifestPath);
    expect(() => runGate(missingManifest, "win32")).toThrow(
      /Cannot read coverage floor manifest/u,
    );

    const damagedManifest = createFixture();
    writeFileSync(damagedManifest.manifestPath, "{not-json", "utf8");
    expect(() => runGate(damagedManifest, "win32")).toThrow(
      /is not valid JSON/u,
    );

    const unsupportedManifest = createFixture();
    unsupportedManifest.manifest.schemaVersion = 3;
    unsupportedManifest.writeManifest();
    expect(() => runGate(unsupportedManifest, "win32")).toThrow(
      /schemaVersion is unsupported/u,
    );

    const mismatchedToolchain = createFixture();
    mismatchedToolchain.manifest.provenance.vitestVersion = "0.0.0";
    mismatchedToolchain.writeManifest();
    expect(() => runGate(mismatchedToolchain, "win32")).toThrow(
      /tool versions do not match/u,
    );

    const unvalidatedRuntime = createFixture();
    unvalidatedRuntime.manifest.provenance.validatedNodeV8 = ["99/99.9"];
    unvalidatedRuntime.writeManifest();
    expect(() => runGate(unvalidatedRuntime, "win32")).toThrow(
      /has not been validated with Node\/V8/u,
    );
  });

  it("rejects damaged floor metrics and missing source files", () => {
    const missingFloorMetric = createFixture();
    delete missingFloorMetric.manifest.floors[missingFloorMetric.existingFile]
      .branches;
    missingFloorMetric.writeManifest();
    expect(() => runGate(missingFloorMetric, "win32")).toThrow(
      /missing or unknown fields/u,
    );

    const inconsistentFloor = createFixture();
    inconsistentFloor.manifest.floors[inconsistentFloor.existingFile].lines = {
      total: 100,
      covered: 79,
      pct: 80,
    };
    inconsistentFloor.writeManifest();
    expect(() => runGate(inconsistentFloor, "win32")).toThrow(
      /coverage floor.*pct does not match its counts/u,
    );

    const missingSource = createFixture();
    rmSync(join(missingSource.root, missingSource.addedFile));
    expect(() => runGate(missingSource, "win32")).toThrow(
      /source file is missing/u,
    );
  });

  it("fails when a future touched source file is omitted from the manifest", () => {
    const fixture = createFixture();
    const collectScope = (): CoverageScope => ({
      existing: [fixture.existingFile, "src/main/future-existing.ts"],
      added: [fixture.addedFile, "src/shared/future-added.ts"],
      deleted: ["src/main/future-deleted.ts"],
    });

    expect(() => runGate(fixture, "win32", collectScope)).toThrow(
      /missing existing floor: src\/main\/future-existing\.ts[\s\S]*missing introduced floor: src\/shared\/future-added\.ts[\s\S]*missing deleted-file policy: src\/main\/future-deleted\.ts/u,
    );
  });

  it("accepts an explicitly recorded deletion without requiring coverage", () => {
    const fixture = createFixture();
    fixture.manifest.deletedFiles = ["src/main/deleted.ts"];
    fixture.writeManifest();

    expect(() =>
      runGate(fixture, "win32", () => ({
        existing: [fixture.existingFile],
        added: [fixture.addedFile],
        deleted: ["src/main/deleted.ts"],
      })),
    ).not.toThrow();
  });

  it("parses modified, untracked, and deleted Git paths with spaces", () => {
    const root = mkdtempSync(join(tmpdir(), "manga-coverage-git-scope-"));
    temporaryDirectories.push(root);
    const modified = "src/main/modified file.ts";
    const deleted = "src/main/deleted file.ts";
    const added = "src/shared/added file.ts";
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "coverage@example.invalid"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Coverage Fixture"], {
      cwd: root,
    });
    write(join(root, modified), "export const before = true;\n");
    write(join(root, deleted), "export const removed = true;\n");
    execFileSync("git", ["add", "--", "src"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "baseline"], {
      cwd: root,
    });
    write(join(root, modified), "export const after = true;\n");
    rmSync(join(root, deleted));
    write(join(root, added), "export const added = true;\n");

    expect(gate.collectCoverageScope(root, "HEAD")).toEqual({
      existing: [modified],
      added: [added],
      deleted: [deleted],
    });
  });

  it("preserves Unicode paths in NUL-delimited Git output", () => {
    expect(
      gate.parseCoverageStatusOutput(
        ["M", "src/main/수정 파일.ts", "D", "src/main/삭제 파일.ts", ""].join(
          "\0",
        ),
        ["src/shared/새 파일.ts", ""].join("\0"),
      ),
    ).toEqual({
      existing: ["src/main/수정 파일.ts"],
      added: ["src/shared/새 파일.ts"],
      deleted: ["src/main/삭제 파일.ts"],
    });
  });

  it("tracks every coverage-eligible source touched since cleanup start", () => {
    const manifestPath = join(
      repositoryRoot,
      "scripts",
      "production-cleanup-coverage-floors.json",
    );
    const manifest = gate.loadCoverageManifest(repositoryRoot, manifestPath);
    const scope = gate.collectCoverageScope(
      repositoryRoot,
      gate.CLEANUP_BASE_COMMIT,
    );

    expect(Object.keys(manifest.floors)).toEqual(scope.existing);
    expect(Object.keys(manifest.introducedFloors)).toEqual(scope.added);
    expect(manifest.deletedFiles).toEqual(scope.deleted);
    expect(scope.existing).toHaveLength(572);
    expect(scope.added).toHaveLength(226);
    expect(scope.deleted).toHaveLength(9);
  });
});

type Fixture = {
  root: string;
  existingFile: string;
  existingFileAbsolute: string;
  addedFile: string;
  addedFileAbsolute: string;
  manifestPath: string;
  coveragePath: string;
  manifest: CoverageManifest;
  coverage: Record<string, CoverageRecord>;
  writeManifest(): void;
  writeCoverage(): void;
};

const CURRENT_NODE_V8_FAMILY = `${process.versions.node.split(".")[0]}/${process.versions.v8
  .split(".")
  .slice(0, 2)
  .join(".")}`;

function createFixture(): Fixture {
  const root = mkdtempSync(
    join(tmpdir(), "manga-production-cleanup-coverage-test-"),
  );
  temporaryDirectories.push(root);
  const existingFile = "src/main/existing.ts";
  const addedFile = "src/shared/added.ts";
  const existingFileAbsolute = join(root, existingFile);
  const addedFileAbsolute = join(root, addedFile);
  const manifestPath = join(root, "scripts", "coverage-floors.json");
  const coveragePath = join(root, "coverage", "coverage-summary.json");
  write(existingFileAbsolute, "export const existing = true;\n");
  write(addedFileAbsolute, "export const added = true;\n");

  const manifest: CoverageManifest = {
    schemaVersion: 2,
    provenance: {
      baseCommit: gate.CLEANUP_BASE_COMMIT,
      baselinePlatform: "win32",
      coverageProvider: "vitest-v8-json-summary",
      sourceArtifact: ".tmp/production-cleanup-coverage-baseline.json",
      sourceArtifactSha256: "a".repeat(64),
      introducedArtifact:
        ".tmp/production-cleanup-coverage-accepted-node22.json",
      introducedArtifactSha256: "b".repeat(64),
      validatedNodeV8: [
        ...new Set(["22/12.4", "24/13.6", CURRENT_NODE_V8_FAMILY]),
      ],
      vitestVersion: "4.1.9",
      coverageV8Version: "4.1.9",
    },
    floors: {
      [existingFile]: {
        lines: coverageFloorMetric(80),
        statements: coverageFloorMetric(80),
        functions: coverageFloorMetric(80),
        branches: coverageFloorMetric(80),
      },
    },
    introducedFloors: {
      [addedFile]: {
        lines: coverageFloorMetric(80),
        statements: coverageFloorMetric(80),
        functions: coverageFloorMetric(80),
        branches: coverageFloorMetric(80),
      },
    },
    deletedFiles: [],
  };
  const coverage: Record<string, CoverageRecord> = {
    total: coverageRecord(160, 200),
    [existingFileAbsolute]: coverageRecord(80),
    [addedFileAbsolute]: coverageRecord(80),
  };
  const fixture: Fixture = {
    root,
    existingFile,
    existingFileAbsolute,
    addedFile,
    addedFileAbsolute,
    manifestPath,
    coveragePath,
    manifest,
    coverage,
    writeManifest: () => writeJson(manifestPath, manifest),
    writeCoverage: () => writeJson(coveragePath, coverage),
  };
  fixture.writeManifest();
  fixture.writeCoverage();
  return fixture;
}

function runGate(
  fixture: Fixture,
  platform: NodeJS.Platform | string,
  collectScope: () => CoverageScope = () => ({
    existing: [fixture.existingFile],
    added: [fixture.addedFile],
    deleted: [],
  }),
) {
  return gate.checkProductionCleanupCoverage({
    root: fixture.root,
    manifestPath: fixture.manifestPath,
    coveragePath: fixture.coveragePath,
    platform,
    collectScope,
  });
}

function coverageRecord(covered: number, total = 100): CoverageRecord {
  return Object.fromEntries(
    gate.COVERAGE_METRICS.map((metric) => [
      metric,
      coverageMetric(covered, total),
    ]),
  );
}

function coverageMetric(covered: number, total = 100): CoverageMetric {
  return {
    total,
    covered,
    skipped: 0,
    pct:
      total === 0 ? 100 : Math.floor((1000 * 100 * covered) / total / 10) / 100,
  };
}

function coverageFloorMetric(
  covered: number,
  total = 100,
): CoverageFloorMetric {
  const metric = coverageMetric(covered, total);
  return {
    total: metric.total,
    covered: metric.covered,
    pct: metric.pct,
  };
}

function writeJson(filePath: string, value: unknown): void {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function write(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}
