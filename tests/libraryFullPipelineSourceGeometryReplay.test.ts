import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readFontMatchingOcrGeometryDirection,
  resolveFontMatchingOcrGeometryDirection,
} from "../src/main/pipeline/fontMatchingOcrGeometryDirection";

type SealBinding = Readonly<{
  kind: string;
  path: string;
  size: number;
  sha256: string;
}>;

type LoadedSeal = Readonly<{
  auditPath: string;
  auditSha256: string;
  pageCount: number;
}>;

type ReplayModule = Readonly<{
  attachFontReplaySourceGeometryDirections: (options: {
    baselineSeal: unknown;
    blocks: unknown[];
    fontInputPath: string;
    fontGeometryDirection: {
      readFontMatchingOcrGeometryDirection: typeof readFontMatchingOcrGeometryDirection;
      resolveFontMatchingOcrGeometryDirection: typeof resolveFontMatchingOcrGeometryDirection;
    };
    pageId: string;
  }) => Promise<{
    blocks: Array<{
      sourceCandidateMembership?: {
        contractVersion: string;
        originalCandidateIds: number[];
        voterCandidateIds: number[];
      };
      sourceGeometryDirection?: { direction: string };
    }>;
    audit: Record<string, unknown>;
  }>;
  loadFontReplayBaselineSeal: (options: {
    auditPath: string;
    expectedRunDir: string;
    expectedPageIds: string[];
  }) => Promise<LoadedSeal>;
  summarizeSourceGeometryDirectionReplay: (
    pages: readonly unknown[],
  ) => Record<string, unknown>;
}>;

type Fixture = Readonly<{
  root: string;
  runDir: string;
  auditPath: string;
  fontInputPath: string;
  pageId: string;
  pageIds: string[];
  sourceImagePath: string;
  sourcePageSha256: string;
  width: number;
  height: number;
}>;

const replay =
  require("../scripts/library-full-pipeline-qa/source-geometry-direction-replay.cjs") as ReplayModule;
const directionModule = {
  readFontMatchingOcrGeometryDirection,
  resolveFontMatchingOcrGeometryDirection,
};
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("full-pipeline source geometry direction replay", () => {
  it("recomputes from 40-page sealed raw OCR and upgrades the voter commitment", async () => {
    const fixture = createFixture();
    const blocks = [
      {
        blockId: "block-1",
        item: { id: 1, candidateIds: [1, 2] },
        sourceGeometryDirection: legacyDirectionEvidence("horizontal", [1]),
      },
    ];
    const resultPath = writeRawResult(fixture, [
      hint(1, 20, 80),
      hint(2, 80, 20),
    ]);
    const baselineSeal = await sealAndLoad(fixture, blocks);

    const replayed = await attach(fixture, blocks, baselineSeal);

    expect(replayed.blocks[0]).toMatchObject({
      sourceCandidateMembership: {
        contractVersion: "font-matching-ocr-candidate-membership-v2",
        originalCandidateIds: [1, 2],
        voterCandidateIds: [1],
      },
      sourceGeometryDirection: { direction: "vertical" },
    });
    expect(replayed.audit).toMatchObject({
      contractVersion: "font-matching-ocr-geometry-replay-v1",
      rawArtifactStatus: "ready",
      rawHintCount: 2,
      blockCount: 1,
      resolvedBlockCount: 1,
      rawResolvedBlockCount: 1,
      existingEvidenceResolvedBlockCount: 0,
      missingBlockCount: 0,
      freshBaselineSeal: {
        path: fixture.auditPath,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        pageCount: 40,
        profile: "fresh-gemma-full",
      },
      fontInputBinding: {
        status: "ready",
        path: fixture.fontInputPath,
        sha256: fileSha256(fixture.fontInputPath),
        sealedSha256: fileSha256(fixture.fontInputPath),
        providedBlockInventoryMatches: true,
      },
      rawArtifacts: [
        {
          path: resultPath,
          sha256: fileSha256(resultPath),
          artifactSource: "analysis_ocr_hints_result",
          sourceBinding: {
            status: "ready",
            pageIdMatches: true,
            imagePathMatches: true,
            sha256Matches: true,
            dimensionsMatch: true,
          },
        },
      ],
    });
    await expect(attach(fixture, blocks, { ...baselineSeal })).rejects.toThrow(
      "verified 40-page fresh baseline seal",
    );
  });

  it("replays voter commitments captured by the current v6 fixed-block request", async () => {
    const fixture = createFixture();
    const blocks = [
      {
        blockId: "block-1",
        item: { id: 1, candidateIds: [1, 2] },
        sourceGeometryDirection: fixedBlockDirectionEvidenceV2(
          "semantic_ocr_fixed_block_request_v6",
          "horizontal",
          [1, 2],
          [1],
        ),
      },
    ];
    writeRawResult(fixture, [hint(1, 20, 80), hint(2, 80, 20)]);
    const baselineSeal = await sealAndLoad(fixture, blocks);

    const replayed = await attach(fixture, blocks, baselineSeal);

    expect(replayed.blocks[0]).toMatchObject({
      sourceCandidateMembership: {
        source: "sealed_font_input_request_block_v2",
        originalCandidateIds: [1, 2],
        voterCandidateIds: [1],
      },
      sourceGeometryDirection: {
        direction: "vertical",
        candidateIds: [1],
      },
    });
  });

  it("ignores raw reviewRole and uses only the sealed code-owned voter list", async () => {
    const fixture = createFixture();
    const blocks = [
      {
        blockId: "block-1",
        item: { id: 1, candidateIds: [1, 2] },
        sourceGeometryDirection: legacyDirectionEvidence("horizontal", [1]),
      },
    ];
    writeRawResult(fixture, [
      { ...hint(1, 20, 80), reviewRole: "ruby" },
      { ...hint(2, 80, 20), reviewRole: "body" },
    ]);
    const baselineSeal = await sealAndLoad(fixture, blocks);

    const replayed = await attach(fixture, blocks, baselineSeal);

    expect(replayed.blocks[0]?.sourceGeometryDirection?.direction).toBe(
      "vertical",
    );
    expect(
      replayed.blocks[0]?.sourceCandidateMembership?.voterCandidateIds,
    ).toEqual([1]);
  });

  it("rejects a baseline seal that does not prove raw-ready coverage for all 40 pages", async () => {
    const fixture = createFixture();
    const blocks = [
      {
        blockId: "block-1",
        item: { id: 1 },
        sourceGeometryDirection: legacyDirectionEvidence("vertical", [1]),
      },
    ];
    sealFontInput(fixture, blocks);
    writeRawResult(fixture, [hint(1, 20, 80)]);
    writeFreshBaselineAudit(fixture, { omitRawPageId: "page-40" });

    await expect(loadSeal(fixture)).rejects.toThrow(
      "at least one raw OCR result",
    );
  });

  it("rejects raw OCR bytes changed after the baseline seal was loaded", async () => {
    const fixture = createFixture();
    const blocks = [
      {
        blockId: "block-1",
        item: { id: 1 },
        sourceGeometryDirection: legacyDirectionEvidence("vertical", [1]),
      },
    ];
    const resultPath = writeRawResult(fixture, [hint(1, 20, 80)]);
    const baselineSeal = await sealAndLoad(fixture, blocks);
    writeJson(resultPath, rawResult(fixture, [hint(1, 80, 20)]));

    await expect(attach(fixture, blocks, baselineSeal)).rejects.toThrow(
      "Sealed artifact drifted",
    );
  });

  it("rejects font-input bytes changed after the baseline seal was loaded", async () => {
    const fixture = createFixture();
    const blocks = [
      {
        blockId: "block-1",
        item: { id: 1 },
        sourceGeometryDirection: legacyDirectionEvidence("vertical", [1]),
      },
    ];
    writeRawResult(fixture, [hint(1, 20, 80)]);
    const baselineSeal = await sealAndLoad(fixture, blocks);
    writeFileSync(fixture.fontInputPath, "{}\n", "utf8");

    await expect(attach(fixture, blocks, baselineSeal)).rejects.toThrow(
      "Sealed artifact drifted",
    );
  });

  it("rejects a changed audit or sidecar and a seal from another run root", async () => {
    const fixture = createFixture();
    const blocks = [
      {
        blockId: "block-1",
        item: { id: 1 },
        sourceGeometryDirection: legacyDirectionEvidence("vertical", [1]),
      },
    ];
    sealFontInput(fixture, blocks);
    writeRawResult(fixture, [hint(1, 20, 80)]);
    writeFreshBaselineAudit(fixture);
    writeFileSync(
      `${fixture.auditPath}.sha256`,
      `${"0".repeat(64)}  ${basename(fixture.auditPath)}\n`,
    );

    await expect(loadSeal(fixture)).rejects.toThrow("sidecar is invalid");

    writeFreshBaselineAudit(fixture);
    await expect(
      replay.loadFontReplayBaselineSeal({
        auditPath: fixture.auditPath,
        expectedRunDir: join(fixture.root, "another-run"),
        expectedPageIds: fixture.pageIds,
      }),
    ).rejects.toThrow("not bound to cache-from");
  });

  it("fails closed when provided blocks differ from the sealed font-input", async () => {
    const fixture = createFixture();
    const sealedBlocks = [
      {
        blockId: "sealed",
        item: { id: 1 },
        sourceGeometryDirection: legacyDirectionEvidence("vertical", [1]),
      },
    ];
    writeRawResult(fixture, [hint(1, 20, 80)]);
    const baselineSeal = await sealAndLoad(fixture, sealedBlocks);

    await expect(
      attach(
        fixture,
        [
          {
            blockId: "provided",
            item: { id: 1 },
            sourceGeometryDirection: legacyDirectionEvidence("vertical", [1]),
          },
        ],
        baselineSeal,
      ),
    ).rejects.toThrow("request inventory drifted");
  });

  it("summarizes strict ready-only replay provenance", () => {
    const summary = replay.summarizeSourceGeometryDirectionReplay([
      {
        sourceGeometryDirectionReplay: {
          rawArtifactStatus: "ready",
          blockCount: 3,
          resolvedBlockCount: 3,
          rawResolvedBlockCount: 3,
          existingEvidenceResolvedBlockCount: 0,
          missingBlockCount: 0,
        },
      },
      {},
    ]);

    expect(summary).toEqual({
      contractVersion: "font-matching-ocr-geometry-replay-summary-v1",
      pageCount: 2,
      auditedPageCount: 1,
      rawReadyPageCount: 1,
      rawMissingPageCount: 0,
      rawConflictPageCount: 0,
      rawInvalidPageCount: 0,
      blockCount: 3,
      resolvedBlockCount: 3,
      rawResolvedBlockCount: 3,
      existingEvidenceResolvedBlockCount: 0,
      missingBlockCount: 0,
    });
  });
});

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mgt-direction-replay-"));
  temporaryRoots.push(root);
  const runDir = join(root, "fresh-run");
  const sourceImagePath = join(runDir, "sources", "page-1.png");
  writeFile(sourceImagePath, "sealed-source-image-page-1");
  return {
    root,
    runDir,
    auditPath: join(root, "seals", "fresh-baseline-audit.json"),
    fontInputPath: join(runDir, "pages", "01", "font-input.json"),
    pageId: "page-1",
    pageIds: Array.from({ length: 40 }, (_, index) => `page-${index + 1}`),
    sourceImagePath,
    sourcePageSha256: fileSha256(sourceImagePath),
    width: 1000,
    height: 1500,
  };
}

async function sealAndLoad(fixture: Fixture, blocks: unknown[]) {
  sealFontInput(fixture, blocks);
  if (!existsSync(rawResultPath(fixture, fixture.pageId))) {
    writeRawResult(fixture, [hint(1, 20, 80)]);
  }
  writeFreshBaselineAudit(fixture);
  return loadSeal(fixture);
}

function loadSeal(fixture: Fixture) {
  return replay.loadFontReplayBaselineSeal({
    auditPath: fixture.auditPath,
    expectedRunDir: fixture.runDir,
    expectedPageIds: fixture.pageIds,
  });
}

function attach(fixture: Fixture, blocks: unknown[], baselineSeal: unknown) {
  return replay.attachFontReplaySourceGeometryDirections({
    baselineSeal,
    blocks,
    fontInputPath: fixture.fontInputPath,
    fontGeometryDirection: directionModule,
    pageId: fixture.pageId,
  });
}

function sealFontInput(fixture: Fixture, blocks: unknown[]): void {
  writeJson(
    fixture.fontInputPath,
    fontInputPayload(
      fixture.pageId,
      fixture.sourceImagePath,
      fixture.sourcePageSha256,
      fixture.width,
      fixture.height,
      blocks,
    ),
  );
}

function fontInputPayload(
  pageId: string,
  sourceImagePath: string,
  sourcePageSha256: string,
  width: number,
  height: number,
  blocks: unknown[],
) {
  return {
    schemaVersion: 1,
    sourcePageId: pageId,
    sourcePageSha256,
    page: { id: pageId, imagePath: sourceImagePath, width, height },
    requestBlocks: blocks,
  };
}

function writeRawResult(fixture: Fixture, hints: unknown[]): string {
  const resultPath = rawResultPath(fixture, fixture.pageId);
  writeJson(resultPath, rawResult(fixture, hints));
  return resultPath;
}

function rawResultPath(fixture: Fixture, pageId: string): string {
  return join(
    fixture.runDir,
    "analysis",
    `job-${pageId}`,
    "ocr-hints",
    pageId,
    "result.json",
  );
}

function rawResult(fixture: Fixture, hints: unknown[]) {
  return rawResultForPage(
    fixture.sourceImagePath,
    fixture.width,
    fixture.height,
    hints,
  );
}

function rawResultForPage(
  imagePath: string,
  width: number,
  height: number,
  hints: unknown[],
) {
  return {
    imagePath,
    width,
    height,
    sourceLanguage: "ja",
    configuration: {
      ocrBboxMode: "ocr",
      ocrEngine: "transformers",
      ocrVersion: "PP-OCRv6",
      ocrMergeMode: "semantic",
    },
    schemaVersion: 10,
    hints,
    diagnostics: [{ provider: "paddleocr-vl" }],
    noTextDetected: false,
  };
}

function writeFreshBaselineAudit(
  fixture: Fixture,
  options: { omitRawPageId?: string } = {},
): void {
  const reportPath = join(fixture.runDir, "run-report.json");
  const configPath = join(fixture.runDir, "run-config.json");
  writeJson(reportPath, { status: "completed" });
  writeJson(configPath, { provider: "gemma" });
  const bindings: SealBinding[] = [
    fileBinding(reportPath, "run_report_json"),
    fileBinding(configPath, "run_config_json"),
  ];
  const pages = fixture.pageIds.map((pageId, index) => {
    const number = index + 1;
    let fontInputPath = fixture.fontInputPath;
    let imagePath = fixture.sourceImagePath;
    let imageSha256 = fixture.sourcePageSha256;
    let width = fixture.width;
    let height = fixture.height;
    if (number > 1) {
      imagePath = join(fixture.runDir, "sources", `${pageId}.png`);
      writeFile(imagePath, `sealed-source-image-${pageId}`);
      imageSha256 = fileSha256(imagePath);
      width += number;
      height += number;
      fontInputPath = join(
        fixture.runDir,
        "pages",
        String(number).padStart(2, "0"),
        "font-input.json",
      );
      writeJson(
        fontInputPath,
        fontInputPayload(pageId, imagePath, imageSha256, width, height, []),
      );
    }
    const rawPath = rawResultPath(fixture, pageId);
    if (!existsSync(rawPath)) {
      writeJson(
        rawPath,
        rawResultForPage(imagePath, width, height, [hint(number, 20, 80)]),
      );
    }
    const artifacts = [fileBinding(fontInputPath, "font_input_json")];
    if (options.omitRawPageId !== pageId) {
      artifacts.push(fileBinding(rawPath, "raw_ocr_result_json"));
    }
    bindings.push(...artifacts);
    return {
      selectionIndex: index,
      sourcePageId: pageId,
      sourcePageSha256: imageSha256,
      artifacts,
    };
  });
  const audit = {
    schemaVersion: 1,
    tool: {
      id: "manga-library-full-pipeline-font-qa-run-seal",
      version: "1.1.0",
    },
    profile: "fresh-gemma-full",
    runIdentity: {
      runId: "fresh-fixture",
      cohort: "baseline40",
      cohortDigest: "fixture",
      candidateId: "fixture",
      pageCount: 40,
    },
    execution: {
      provider: "gemma",
      cacheFrom: null,
      pageMode: "full",
      fontInferenceMode: "live_full_pipeline",
      qaPageRelativeRoleReroute: false,
    },
    pages,
    bindings,
    contentSha256: "a".repeat(64),
  };
  writeJson(fixture.auditPath, audit);
  writeFile(
    `${fixture.auditPath}.sha256`,
    `${fileSha256(fixture.auditPath)}  ${basename(fixture.auditPath)}\n`,
  );
}

function fileBinding(filePath: string, kind: string): SealBinding {
  return {
    kind,
    path: filePath,
    size: statSync(filePath).size,
    sha256: fileSha256(filePath),
  };
}

function legacyDirectionEvidence(
  direction: "horizontal" | "vertical",
  candidateIds: readonly number[],
) {
  return {
    contractVersion: "font-matching-ocr-geometry-direction-v1" as const,
    source: "semantic_ocr_candidate_bbox_majority" as const,
    direction,
    candidateIds,
  };
}

function fixedBlockDirectionEvidenceV2(
  source:
    | "semantic_ocr_fixed_block_request_v5"
    | "semantic_ocr_fixed_block_request_v6",
  direction: "horizontal" | "vertical",
  originalCandidateIds: readonly number[],
  voterCandidateIds: readonly number[],
) {
  return {
    contractVersion: "font-matching-ocr-geometry-direction-v2" as const,
    source: "semantic_ocr_candidate_bbox_majority" as const,
    direction,
    candidateIds: voterCandidateIds,
    candidateMembership: {
      contractVersion: "font-matching-ocr-candidate-membership-v2" as const,
      source,
      bindingId: "B001",
      originalCandidateIds,
      voterCandidateIds,
    },
  };
}

function hint(id: number, width: number, height: number) {
  return { id, x1: 10, y1: 20, x2: 10 + width, y2: 20 + height };
}

function fileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function writeJson(filePath: string, value: unknown): void {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(filePath: string, value: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}
