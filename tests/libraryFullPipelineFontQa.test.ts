import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Boundary = {
  pageIds: Set<string>;
  relativePaths: Set<string>;
  sourcePageSha256s: Set<string>;
};

type WorkBoundary = {
  workIds: Set<string>;
  files: Array<{
    path: string;
    sizeBytes: number;
    sha256: string;
    recordsRead: number;
  }>;
  recordsRead: number;
};

type Candidate = {
  workId: string;
  chapterId: string;
  pageId: string;
  imageRelativePath: string;
  variantSignalCount: number;
  variantSignals: { strongTotal: number; geometryProxy: number };
};

type FrozenCohortRecord = {
  work: { id: string };
  [key: string]: unknown;
};

type QaCliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type SelectionModule = {
  cohortDigest: (records: unknown[]) => string;
  excludeTrainingOverlap: (
    candidates: Candidate[],
    boundary: Boundary,
  ) => Candidate[];
  excludeWorkBoundaryOverlap: (
    candidates: Candidate[],
    boundary: WorkBoundary,
  ) => Candidate[];
  readLibraryCandidates: (root: string) => Promise<Candidate[]>;
  scanTrainingBoundaries: (inputs: string[]) => Promise<Boundary>;
  scanWorkBoundaries: (inputs: string[]) => Promise<WorkBoundary>;
  selectQaCohorts: (
    candidates: Candidate[],
    options: { seed: string; baselineCount: number; holdoutCount: number },
  ) => { baseline: Candidate[]; holdout: Candidate[] };
};

type RunReport = {
  runId: string;
  candidateId: string;
  cohort: string;
  cohortDigest: string;
  completionSemanticsVersion?: string;
  pages: Array<{
    sourcePageId: string;
    status: string;
    renderedImagePath: string;
    renderedImageSha256: string;
    fontDecisions: Array<{
      sourceText: string;
      translatedText: string;
      applied: boolean;
      selectedFontId: string | null;
      role: string;
      confidence: number | null;
    }>;
  }>;
};

type ComparisonModule = {
  buildComparisonMarkdown: (report: unknown) => string;
  compareRuns: (
    baselineDir: string,
    candidateDir: string,
  ) => Promise<{
    guardrails: { passed: boolean; failures: string[] };
    baseline: {
      emphasisDialogueRate: number;
      appliedSingleDayBlocks: number;
      appliedBodyRoleSingleDayBlocks: number;
      bodyRoleConsistencyEligiblePages: number;
      bodyRoleDominantFontShare: number;
      multiFontBodyRolePages: number;
    };
    candidate: {
      emphasisDialogueRate: number;
      appliedSingleDayBlocks: number;
      appliedBodyRoleSingleDayBlocks: number;
      bodyRoleConsistencyEligiblePages: number;
      bodyRoleDominantFontShare: number;
      multiFontBodyRolePages: number;
    };
    deltas: {
      automaticApplyRate: number;
      emphasisDialogueRate: number;
      appliedSingleDayBlocks: number;
      appliedBodyRoleSingleDayBlocks: number;
      bodyRoleDominantFontShare: number;
      bodyRoleConsistencyEligiblePages: number;
      multiFontBodyRolePages: number;
    };
    roleChangedBlocks: number;
    selectedFontChangedBlocks: number;
    diagnosticNote: string;
    pages: Array<{ roleChanges: number; fontChanges: number }>;
    blocks: Array<{
      roleChanged: boolean;
      selectedFontChanged: boolean;
    }>;
  }>;
};

type QaHarnessModule = {
  assertFontMatchingRuntimeReleaseAllowed: (
    runtimeRelease: { qaOnly: boolean; releaseApproved: boolean },
    allowQaOnlyRuntime: boolean,
  ) => void;
  classifyFontMatchingRuntimeReleaseMarker: (marker: unknown) => {
    qaOnly: boolean;
    releaseApproved: boolean;
  };
  parseFontInferenceCacheMode: (value: unknown) => "off" | "required";
  resolveCacheFromSeal: (
    options: Record<string, unknown>,
    cacheFrom: string | null,
    cacheMode: "off" | "required",
    qaPageRelativeRoleReroute: boolean,
  ) => string | null;
};

const selection =
  require("../scripts/library-full-pipeline-qa/selection.cjs") as SelectionModule;
const comparison =
  require("../scripts/library-full-pipeline-qa/comparison.cjs") as ComparisonModule;
const qaHarness =
  require("../scripts/run-library-full-pipeline-qa.cjs") as QaHarnessModule;
const { synchronizeQaRuntimeAssets } =
  require("../scripts/library-full-pipeline-qa/runtime-assets-preflight.cjs") as {
    synchronizeQaRuntimeAssets: (root: string) => {
      status: "built" | "skipped";
      reason: string;
    };
  };
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("library full-pipeline font QA selection", () => {
  it("excludes manifest-owned pages and freezes deterministic diverse cohorts", async () => {
    const root = createLibraryFixture(4, 4);
    const boundaryDir = join(root, "boundary");
    mkdirSync(boundaryDir, { recursive: true });
    const excludedPageId = "page-0-0";
    const excludedPath = "works/work-0/chapters/chapter-0-0/pages/page-0-0.png";
    const excludedSha = "a".repeat(64);
    writeFileSync(
      join(boundaryDir, "manifest.jsonl"),
      [
        {
          page: {
            id: excludedPageId,
            source_locator: { path: excludedPath, file_sha256: excludedSha },
            source_page_sha256: excludedSha,
          },
        },
        {
          page: {
            id: "prior-qa-page",
            imageRelativePath: "works/prior/chapters/qa/pages/page.png",
            imageSha256: "b".repeat(64),
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );

    const boundary = await selection.scanTrainingBoundaries([boundaryDir]);
    const candidates = await selection.readLibraryCandidates(
      join(root, "library"),
    );
    const eligible = selection.excludeTrainingOverlap(candidates, boundary);
    const first = selection.selectQaCohorts(eligible, {
      seed: "fixed-seed",
      baselineCount: 4,
      holdoutCount: 4,
    });
    const second = selection.selectQaCohorts(eligible, {
      seed: "fixed-seed",
      baselineCount: 4,
      holdoutCount: 4,
    });

    expect(boundary.pageIds.has(excludedPageId)).toBe(true);
    expect(boundary.relativePaths.has(excludedPath)).toBe(true);
    expect(boundary.sourcePageSha256s.has(excludedSha)).toBe(true);
    expect(boundary.pageIds.has("prior-qa-page")).toBe(true);
    expect(
      boundary.relativePaths.has("works/prior/chapters/qa/pages/page.png"),
    ).toBe(true);
    expect(boundary.sourcePageSha256s.has("b".repeat(64))).toBe(true);
    expect(eligible.some((item) => item.pageId === excludedPageId)).toBe(false);
    expect(first).toEqual(second);
    expect(new Set(first.baseline.map((item) => item.workId)).size).toBe(4);
    expect(new Set(first.baseline.map((item) => item.chapterId)).size).toBe(4);
    expect(new Set(first.holdout.map((item) => item.chapterId)).size).toBe(4);
    expect(
      first.baseline.filter((item) => item.variantSignals.strongTotal > 0),
    ).toHaveLength(2);
    expect(
      first.holdout.filter((item) => item.variantSignals.strongTotal > 0),
    ).toHaveLength(2);
    expect(
      first.holdout.some((holdout) =>
        first.baseline.some((baseline) => baseline.pageId === holdout.pageId),
      ),
    ).toBe(false);
    expect(
      first.holdout.some((holdout) =>
        first.baseline.some(
          (baseline) => baseline.chapterId === holdout.chapterId,
        ),
      ),
    ).toBe(false);
  });

  it("collects only documented top-level work ids and excludes entire works", async () => {
    const root = createLibraryFixture(5, 2);
    const boundaryDir = join(root, "work-boundary");
    mkdirSync(boundaryDir, { recursive: true });
    const jsonPath = join(boundaryDir, "records.json");
    writeJson(jsonPath, [
      { work_id: "work-0" },
      { workId: "work-1" },
      { work: { id: "work-2" } },
      { provenance: { work_id: "nested-must-not-count" } },
      { work: { id: " " } },
    ]);
    writeFileSync(
      join(boundaryDir, "more.jsonl"),
      `${JSON.stringify({ work_id: "work-0" })}\n${JSON.stringify({ work: { id: "work-3" } })}\n`,
      "utf8",
    );

    const boundary = await selection.scanWorkBoundaries([
      boundaryDir,
      jsonPath,
    ]);
    const candidates = await selection.readLibraryCandidates(
      join(root, "library"),
    );
    const eligible = selection.excludeWorkBoundaryOverlap(candidates, boundary);

    expect([...boundary.workIds].sort()).toEqual([
      "work-0",
      "work-1",
      "work-2",
      "work-3",
    ]);
    expect(boundary.workIds.has("nested-must-not-count")).toBe(false);
    expect(boundary.files).toHaveLength(2);
    expect(
      boundary.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)),
    ).toBe(true);
    expect(boundary.recordsRead).toBe(7);
    expect(new Set(eligible.map((candidate) => candidate.workId))).toEqual(
      new Set(["work-4"]),
    );
  });

  it("jointly splits scarce works while minimizing per-work concentration", () => {
    const candidates = [6, 5, 4, 2, 1, 1].flatMap((chapterCount, workIndex) =>
      Array.from({ length: chapterCount }, (_, chapterIndex) => {
        const variant = chapterIndex % 2 === 0;
        return {
          workId: `work-${workIndex}`,
          chapterId: `chapter-${workIndex}-${chapterIndex}`,
          pageId: `page-${workIndex}-${chapterIndex}`,
          imageRelativePath: `work-${workIndex}/${chapterIndex}.png`,
          variantSignalCount: variant ? 1 : 0,
          variantSignals: {
            strongTotal: variant ? 1 : 0,
            geometryProxy: 0,
          },
        };
      }),
    );

    const cohorts = selection.selectQaCohorts(candidates, {
      seed: "joint-scarce-work-seed",
      baselineCount: 8,
      holdoutCount: 8,
    });
    const baselineCounts = countByWork(cohorts.baseline);
    const holdoutCounts = countByWork(cohorts.holdout);

    expect(cohorts.baseline).toHaveLength(8);
    expect(cohorts.holdout).toHaveLength(8);
    expect(baselineCounts.size).toBe(5);
    expect(holdoutCounts.size).toBe(5);
    expect(Math.max(...baselineCounts.values())).toBe(2);
    expect(Math.max(...holdoutCounts.values())).toBe(2);
    expect(
      cohorts.baseline.filter((candidate) => candidate.variantSignalCount > 0),
    ).toHaveLength(4);
    expect(
      cohorts.holdout.filter((candidate) => candidate.variantSignalCount > 0),
    ).toHaveLength(4);
    expect(
      countSetOverlap(
        new Set(cohorts.baseline.map((candidate) => candidate.pageId)),
        new Set(cohorts.holdout.map((candidate) => candidate.pageId)),
      ),
    ).toBe(0);
    expect(
      countSetOverlap(
        new Set(cohorts.baseline.map((candidate) => candidate.chapterId)),
        new Set(cohorts.holdout.map((candidate) => candidate.chapterId)),
      ),
    ).toBe(0);
    expect(
      countSetOverlap(
        new Set(baselineCounts.keys()),
        new Set(holdoutCounts.keys()),
      ),
    ).toBe(4);
  });

  it("seals work boundaries and inspect fails closed on drift or cohort overlap", () => {
    const root = createLibraryFixture(5, 3);
    const sourceBoundaryPath = join(root, "empty-source-boundary.jsonl");
    const workBoundaryPath = join(root, "training-overlay.jsonl");
    const outputRoot = join(root, "qa-output");
    const workBoundaryContents = `${JSON.stringify({ work_id: "work-0" })}\n`;
    writeFileSync(sourceBoundaryPath, "", "utf8");
    writeFileSync(workBoundaryPath, workBoundaryContents, "utf8");

    const selected = runQaCli([
      "select",
      "--library",
      join(root, "library"),
      "--output",
      outputRoot,
      "--seed",
      "work-boundary-seed",
      "--count",
      "2",
      "--holdout-count",
      "2",
      "--boundary",
      sourceBoundaryPath,
      "--work-boundary",
      workBoundaryPath,
    ]);
    expect(selected.status, selected.stderr).toBe(0);

    const selectionPath = join(outputRoot, "selection.json");
    const frozen = JSON.parse(readFileSync(selectionPath, "utf8"));
    expect(frozen.workBoundary).toMatchObject({
      fileCount: 1,
      recordsRead: 1,
      excludedWorkCount: 1,
      matchedLibraryWorkCount: 1,
      excludedLibraryPages: 3,
      bindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      files: [
        expect.objectContaining({
          path: resolve(workBoundaryPath),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ],
    });
    expect(frozen.candidatePool).toMatchObject({
      excludedByWorkBoundary: 3,
      excludedWorksByWorkBoundary: 1,
    });
    expect(frozen.cohortSelection).toEqual({
      algorithmVersion: "joint-interleaved-work-diversity-v1",
      policy: expect.any(String),
      pageDisjointAcrossCohorts: true,
      chapterDisjointAcrossCohorts: true,
      variantReservationFraction: 0.5,
    });
    expect(runQaCli(["inspect", "--output", outputRoot]).status).toBe(0);

    writeFileSync(workBoundaryPath, `${workBoundaryContents}\n`, "utf8");
    const drifted = runQaCli(["inspect", "--output", outputRoot]);
    expect(drifted.status).toBe(1);
    expect(drifted.stdout).toContain("work_boundary_binding_mismatch");
    writeFileSync(workBoundaryPath, workBoundaryContents, "utf8");

    const baselinePath = frozen.cohorts.baseline40.manifestPath;
    const baselineRecords = readJsonlFixture(baselinePath);
    baselineRecords[0].work.id = "work-0";
    writeFileSync(
      baselinePath,
      `${baselineRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    frozen.cohorts.baseline40.manifestSha256 =
      selection.cohortDigest(baselineRecords);
    writeJson(selectionPath, frozen);

    const overlapped = runQaCli(["inspect", "--output", outputRoot]);
    expect(overlapped.status).toBe(1);
    expect(overlapped.stdout).toContain("work_boundary_work_id:work-0");
  });
});

describe("library full-pipeline font QA comparison", () => {
  it("pairs the frozen cohort and reports font-selection changes", async () => {
    const root = makeTemporaryRoot();
    const baselineDir = join(root, "baseline");
    const candidateDir = join(root, "candidate");
    mkdirSync(baselineDir);
    mkdirSync(candidateDir);
    writeRunReport(
      baselineDir,
      buildRunReport("baseline", "nanum-gothic", 0.8),
    );
    writeRunReport(candidateDir, buildRunReport("candidate", "gugi", 0.9));

    const result = await comparison.compareRuns(baselineDir, candidateDir);

    expect(result.guardrails).toEqual({
      passed: true,
      failures: [],
      note: expect.any(String),
    });
    expect(result.deltas.automaticApplyRate).toBe(0);
    expect(result.roleChangedBlocks).toBe(0);
    expect(result.selectedFontChangedBlocks).toBe(1);
    expect(result.pages[0]).toMatchObject({ roleChanges: 0, fontChanges: 1 });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.roleChanged).toBe(false);
    expect(result.blocks[0]?.selectedFontChanged).toBe(true);
  });

  it("reports role, Single Day, and same-page body-font diagnostics without failing guardrails", async () => {
    const root = makeTemporaryRoot();
    const baselineDir = join(root, "baseline");
    const candidateDir = join(root, "candidate");
    mkdirSync(baselineDir);
    mkdirSync(candidateDir);
    const baseline = buildRunReport("baseline", "nanum-gothic", 0.8);
    baseline.pages[0].fontDecisions = [
      buildFontDecision("dialogue", "nanum-gothic"),
      buildFontDecision("narration", "nanum-gothic"),
      buildFontDecision("thought", "gugi"),
      buildFontDecision("emphasis_dialogue", "dohyeon"),
      buildFontDecision("sfx_impact", "single-day"),
      buildFontDecision("sfx_impact", "jua"),
    ];
    const candidate = buildRunReport("candidate", "nanum-gothic", 0.9);
    candidate.pages[0].fontDecisions = [
      buildFontDecision("dialogue", "nanum-gothic"),
      buildFontDecision("emphasis_dialogue", "nanum-gothic"),
      buildFontDecision("thought", "single-day"),
      buildFontDecision("emphasis_dialogue", "dohyeon"),
      buildFontDecision("sfx_impact", "single-day"),
      buildFontDecision("emphasis_dialogue", "jua"),
    ];
    writeRunReport(baselineDir, baseline);
    writeRunReport(candidateDir, candidate);

    const result = await comparison.compareRuns(baselineDir, candidateDir);

    expect(result.guardrails.passed).toBe(true);
    expect(result.guardrails.failures).toEqual([]);
    expect(result.roleChangedBlocks).toBe(2);
    expect(result.selectedFontChangedBlocks).toBe(1);
    expect(result.pages[0]).toMatchObject({ roleChanges: 2, fontChanges: 1 });
    expect(result.baseline.emphasisDialogueRate).toBeCloseTo(1 / 6);
    expect(result.candidate.emphasisDialogueRate).toBeCloseTo(3 / 6);
    expect(result.deltas.emphasisDialogueRate).toBeCloseTo(2 / 6);
    expect(result.baseline.appliedSingleDayBlocks).toBe(1);
    expect(result.candidate.appliedSingleDayBlocks).toBe(2);
    expect(result.deltas.appliedSingleDayBlocks).toBe(1);
    expect(result.baseline.appliedBodyRoleSingleDayBlocks).toBe(0);
    expect(result.candidate.appliedBodyRoleSingleDayBlocks).toBe(1);
    expect(result.deltas.appliedBodyRoleSingleDayBlocks).toBe(1);
    expect(result.baseline.bodyRoleConsistencyEligiblePages).toBe(1);
    expect(result.candidate.bodyRoleConsistencyEligiblePages).toBe(1);
    expect(result.deltas.bodyRoleConsistencyEligiblePages).toBe(0);
    expect(result.baseline.bodyRoleDominantFontShare).toBeCloseTo(2 / 3);
    expect(result.candidate.bodyRoleDominantFontShare).toBeCloseTo(1 / 2);
    expect(result.deltas.bodyRoleDominantFontShare).toBeCloseTo(-1 / 6);
    expect(result.baseline.multiFontBodyRolePages).toBe(1);
    expect(result.candidate.multiFontBodyRolePages).toBe(1);
    expect(result.deltas.multiFontBodyRolePages).toBe(0);
    expect(result.diagnosticNote).toContain("manual-review diagnostics only");

    const markdown = comparison.buildComparisonMarkdown(result);
    expect(markdown).toContain("Changed blocks (role / selected font): 2 / 1");
    expect(markdown).toContain("Emphasis-dialogue rate: 16.67% → 50.00%");
    expect(markdown).toContain(
      "Applied Single Day blocks (all / body role): 1 / 0 → 2 / 1 (Δ +1 / +1)",
    );
    expect(markdown).toContain("never pass or fail structural guardrails");
  });

  it("refuses comparisons across different frozen cohorts", async () => {
    const root = makeTemporaryRoot();
    const baselineDir = join(root, "baseline");
    const candidateDir = join(root, "candidate");
    mkdirSync(baselineDir);
    mkdirSync(candidateDir);
    const baseline = buildRunReport("baseline", "nanum-gothic", 0.8);
    const candidate = {
      ...buildRunReport("candidate", "gugi", 0.9),
      cohortDigest: "different",
    };
    writeRunReport(baselineDir, baseline);
    writeRunReport(candidateDir, candidate);

    await expect(
      comparison.compareRuns(baselineDir, candidateDir),
    ).rejects.toThrow("same frozen cohort");
  });

  it("refuses to mix legacy execution-only and production completion semantics", async () => {
    const root = makeTemporaryRoot();
    const baselineDir = join(root, "baseline");
    const candidateDir = join(root, "candidate");
    mkdirSync(baselineDir);
    mkdirSync(candidateDir);
    writeRunReport(
      baselineDir,
      buildRunReport("baseline", "nanum-gothic", 0.8),
    );
    writeRunReport(candidateDir, {
      ...buildRunReport("candidate", "gugi", 0.9),
      completionSemanticsVersion: "library-full-pipeline-qa-page-completion-v1",
    });

    await expect(
      comparison.compareRuns(baselineDir, candidateDir),
    ).rejects.toThrow("different completion semantics");
  });
});

describe("library full-pipeline font QA runtime release guard", () => {
  it("registers the production font protocol around Electron readiness", () => {
    const runner = readFileSync(
      resolve("scripts/library-full-pipeline-qa/electron-runner.cjs"),
      "utf8",
    );
    const schemeRegistration = runner.indexOf(
      "imageProtocol.registerImageProtocolScheme();",
    );
    const appReady = runner.indexOf("await app.whenReady();");
    const handlerRegistration = runner.indexOf(
      "imageProtocol.registerImageProtocolHandler();",
    );

    expect(schemeRegistration).toBeGreaterThan(-1);
    expect(appReady).toBeGreaterThan(schemeRegistration);
    expect(handlerRegistration).toBeGreaterThan(appReady);
  });

  it("seals replay direction provenance from raw OCR artifacts", () => {
    const runner = readFileSync(
      resolve("scripts/library-full-pipeline-qa/electron-runner.cjs"),
      "utf8",
    );
    const replay = readFileSync(
      resolve(
        "scripts/library-full-pipeline-qa/source-geometry-direction-replay.cjs",
      ),
      "utf8",
    );

    expect(replay).toContain('binding.kind === "raw_ocr_result_json"');
    expect(replay).toContain("expectedResultPathSuffix");
    expect(replay).toContain(
      'contractVersion: "font-matching-ocr-geometry-replay-v1"',
    );
    expect(replay).toContain("rawResolvedBlockCount");
    expect(replay).toContain("missingBlockCount");
    expect(replay).toContain('createHash("sha256").update(bytes)');
    expect(replay).toContain("loadFontReplayBaselineSeal");
    expect(replay).toContain("sealed_font_input_request_block_v2");
    expect(replay).not.toContain('raw.status === "missing"');
    expect(runner).toContain(
      'require("./source-geometry-direction-replay.cjs")',
    );
    expect(runner).toContain("loadFontReplayBaselineSeal");
    expect(runner).toContain("cacheFromSeal");
    expect(runner).toContain("trace.sourceGeometryDirectionReplay");
  });

  it("stages runtime source additions before a production QA run can start", () => {
    const root = makeTemporaryRoot();
    const scriptsDir = join(root, "scripts");
    const runtimeDir = join(root, "src", "main", "runtime", "semantic-ocr");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(scriptsDir, "prepare-runtime.cjs"), "fixture");
    writeFileSync(join(scriptsDir, "dev-build-cache.cjs"), "fixture");
    writeFileSync(join(runtimeDir, "existing.cjs"), "existing");

    expect(synchronizeQaRuntimeAssets(root).status).toBe("built");
    expect(
      readFileSync(
        join(root, "out", "app-runtime", "semantic-ocr", "existing.cjs"),
        "utf8",
      ),
    ).toBe("existing");

    writeFileSync(join(runtimeDir, "new-global-stabilizer.cjs"), "global");
    expect(synchronizeQaRuntimeAssets(root)).toMatchObject({
      status: "built",
      reason: "input content changed",
    });
    expect(
      existsSync(
        join(
          root,
          "out",
          "app-runtime",
          "semantic-ocr",
          "new-global-stabilizer.cjs",
        ),
      ),
    ).toBe(true);
    expect(synchronizeQaRuntimeAssets(root)).toEqual({
      status: "skipped",
      reason: "input and output content are unchanged",
    });
  });

  it("persists explicit holdout authorization in the dry-run config", () => {
    const root = makeTemporaryRoot();
    const outputRoot = join(root, "qa-output");
    mkdirSync(outputRoot, { recursive: true });
    writeJson(join(outputRoot, "selection.json"), {
      cohorts: {
        holdout40: {
          manifestPath: join(root, "holdout40.jsonl"),
          manifestSha256: "a".repeat(64),
        },
      },
    });

    const result = runQaCli([
      "run",
      "--output",
      outputRoot,
      "--cohort",
      "holdout40",
      "--allow-holdout",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"cohort": "holdout40"');
    expect(result.stdout).toContain('"allowHoldout": true');
  });

  it("only accepts fail-closed cached inference reuse", () => {
    expect(qaHarness.parseFontInferenceCacheMode(undefined)).toBe("off");
    expect(qaHarness.parseFontInferenceCacheMode("required")).toBe("required");
    expect(() => qaHarness.parseFontInferenceCacheMode("fallback")).toThrow(
      /must be required/,
    );
    expect(() => qaHarness.parseFontInferenceCacheMode(true)).toThrow(
      /must be required/,
    );
  });

  it("requires a fresh baseline seal for every live cache replay", () => {
    const cacheFrom = resolve("fixture-fresh-run");
    const sealPath = resolve("fixture-fresh-run-audit.json");

    expect(() =>
      qaHarness.resolveCacheFromSeal({}, cacheFrom, "off", false),
    ).toThrow(/requires --cache-from-seal/);
    expect(
      qaHarness.resolveCacheFromSeal(
        { "cache-from-seal": sealPath },
        cacheFrom,
        "off",
        true,
      ),
    ).toBe(sealPath);
    expect(
      qaHarness.resolveCacheFromSeal({}, cacheFrom, "required", false),
    ).toBeNull();
    expect(() =>
      qaHarness.resolveCacheFromSeal(
        { "cache-from-seal": sealPath, "page-limit": "1" },
        cacheFrom,
        "off",
        true,
      ),
    ).toThrow(/complete 40-page cohort/);
  });

  it("requires explicit permission for an exact QA-only marker", () => {
    const qaOnly = qaHarness.classifyFontMatchingRuntimeReleaseMarker({
      qa_only: true,
      release_approved: false,
    });
    const production = qaHarness.classifyFontMatchingRuntimeReleaseMarker({
      owner: "production-fixture",
    });

    expect(qaOnly).toEqual({ qaOnly: true, releaseApproved: false });
    expect(() =>
      qaHarness.assertFontMatchingRuntimeReleaseAllowed(qaOnly, false),
    ).toThrow(/--allow-qa-only-runtime/);
    expect(() =>
      qaHarness.assertFontMatchingRuntimeReleaseAllowed(qaOnly, true),
    ).not.toThrow();
    expect(() =>
      qaHarness.assertFontMatchingRuntimeReleaseAllowed(production, false),
    ).not.toThrow();
  });

  it.each([
    { qa_only: true },
    { release_approved: false },
    { qa_only: false, release_approved: false },
    { qa_only: true, release_approved: true },
  ])("rejects ambiguous QA marker flags: %j", (marker) => {
    expect(() =>
      qaHarness.classifyFontMatchingRuntimeReleaseMarker(marker),
    ).toThrow(/must be exactly qa_only=true and release_approved=false/);
  });

  it("blocks a QA-only runtime at CLI preflight before Electron starts", () => {
    const root = makeTemporaryRoot();
    const outputRoot = join(root, "qa-output");
    const runtimeDir = join(root, "qa-runtime");
    mkdirSync(outputRoot, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    writeJson(join(outputRoot, "selection.json"), {
      cohorts: {
        baseline40: {
          manifestPath: join(root, "baseline40.jsonl"),
          manifestSha256: "a".repeat(64),
        },
      },
    });
    writeJson(join(runtimeDir, ".font-matching-runtime-artifact-owned.json"), {
      qa_only: true,
      release_approved: false,
    });

    const blocked = runQaCli([
      "run",
      "--output",
      outputRoot,
      "--runtime-dir",
      runtimeDir,
      "--preflight",
    ]);

    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("--allow-qa-only-runtime");
  });
});

function createLibraryFixture(workCount: number, chapterCount: number): string {
  const root = makeTemporaryRoot();
  const libraryRoot = join(root, "library");
  const workOrder = Array.from(
    { length: workCount },
    (_, index) => `work-${index}`,
  );
  mkdirSync(join(libraryRoot, "works"), { recursive: true });
  writeJson(join(libraryRoot, "index.json"), { workOrder });
  for (let workIndex = 0; workIndex < workCount; workIndex += 1) {
    const workId = `work-${workIndex}`;
    const workDir = join(libraryRoot, "works", workId);
    const chapterOrder = Array.from(
      { length: chapterCount },
      (_, chapterIndex) => `chapter-${workIndex}-${chapterIndex}`,
    );
    mkdirSync(workDir, { recursive: true });
    writeJson(join(workDir, "work.json"), {
      id: workId,
      title: `Work ${workIndex}`,
      chapterOrder,
    });
    for (let chapterIndex = 0; chapterIndex < chapterCount; chapterIndex += 1) {
      createChapterFixture(libraryRoot, workId, workIndex, chapterIndex);
    }
  }
  return root;
}

function createChapterFixture(
  libraryRoot: string,
  workId: string,
  workIndex: number,
  chapterIndex: number,
): void {
  const chapterId = `chapter-${workIndex}-${chapterIndex}`;
  const pageId = `page-${workIndex}-${chapterIndex}`;
  const chapterDir = join(libraryRoot, "works", workId, "chapters", chapterId);
  const pagesDir = join(chapterDir, "pages");
  const imagePath = join(pagesDir, `${pageId}.png`);
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(imagePath, Buffer.from(`image-${workIndex}-${chapterIndex}`));
  writeJson(join(chapterDir, "chapter.json"), {
    id: chapterId,
    workId,
    title: `Chapter ${chapterIndex}`,
    pageOrder: [pageId],
    pages: [
      {
        id: pageId,
        name: `${pageId}.png`,
        imagePath,
        width: 1000,
        height: 1500,
        blocks:
          chapterIndex % 2 === 0
            ? [{ type: "sfx", bboxSpace: "normalized_1000" }]
            : [],
      },
    ],
  });
}

function buildRunReport(
  runId: string,
  fontId: string,
  confidence: number,
): RunReport {
  return {
    runId,
    candidateId: runId,
    cohort: "baseline40",
    cohortDigest: "cohort-sha",
    pages: [
      {
        sourcePageId: "page-1",
        status: "completed",
        renderedImagePath: `${runId}.png`,
        renderedImageSha256: createHash("sha256").update(runId).digest("hex"),
        fontDecisions: [
          {
            sourceText: "source",
            translatedText: "번역",
            applied: true,
            selectedFontId: fontId,
            role: "sfx_impact",
            confidence,
          },
        ],
      },
    ],
  };
}

function buildFontDecision(
  role: string,
  selectedFontId: string,
): RunReport["pages"][number]["fontDecisions"][number] {
  return {
    sourceText: "source",
    translatedText: "번역",
    applied: true,
    selectedFontId,
    role,
    confidence: 0.8,
  };
}

function writeRunReport(directory: string, report: RunReport): void {
  writeJson(join(directory, "run-report.json"), report);
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonlFixture(filePath: string): FrozenCohortRecord[] {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FrozenCohortRecord);
}

function countByWork(candidates: Candidate[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.workId, (counts.get(candidate.workId) || 0) + 1);
  }
  return counts;
}

function countSetOverlap(left: Set<string>, right: Set<string>): number {
  return [...left].filter((value) => right.has(value)).length;
}

function runQaCli(arguments_: string[]): QaCliResult {
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/run-library-full-pipeline-qa.cjs"), ...arguments_],
    { cwd: resolve("."), encoding: "utf8" },
  );
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

function makeTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mgt-font-qa-"));
  temporaryRoots.push(root);
  return resolve(root);
}
