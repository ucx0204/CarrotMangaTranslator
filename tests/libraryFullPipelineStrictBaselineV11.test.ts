import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Candidate = {
  workId: string;
  chapterId: string;
  pageId: string;
  imageRelativePath: string;
  variantSignalCount: number;
  variantSignals: { strongTotal: number };
};

type SourceBoundary = {
  pageIds: Set<string>;
  relativePaths: Set<string>;
  sourcePageSha256s: Set<string>;
  referencedWorkIds: Set<string>;
  files: unknown[];
  recordsRead: number;
};

type StrictSelectionModule = {
  assertNotCurrentV10Holdout: (path: string) => void;
  collectSourcePageIdentities: (
    value: unknown,
    boundary: SourceBoundary,
  ) => void;
  scanMasterWorkUnion: (path: string) => Promise<{
    workIds: Set<string>;
    recordsRead: number;
    splitRows: { train: number; val: number; test: number };
    works: Map<
      string,
      { pageIds: Set<string>; chapterIds: Set<string>; rows: number }
    >;
  }>;
  selectStrictBaseline: (
    candidates: Candidate[],
    options: { seed: string; target: number; maxPagesPerWork: number },
  ) => Candidate[];
  validateStrictBaselineRecords: (
    records: unknown[],
    contract: {
      target: number;
      maxPagesPerWork: number;
      workIds: Set<string>;
      sourceBoundary: SourceBoundary;
    },
  ) => {
    errors: string[];
    pages: number;
    works: number;
    chapters: number;
    maximumPagesPerWork: number;
  };
};

type RunnerBuilderModule = {
  runnerCohortDetails: (
    binding: { path: string; sizeBytes: number; sha256: string },
    manifestSha256: string,
    summary: { pages: number },
  ) => {
    path: string;
    manifestPath: string;
    manifestSha256: string;
    pages: number;
  };
  buildRunnerBoundaryContract: (
    prepared: {
      sourceBoundary: SourceBoundary & {
        files: Array<{
          path: string;
          sizeBytes: number;
          sha256: string;
          recordsRead: number;
        }>;
      };
      workBoundary: { workIds: Set<string> };
      stats: { excludedByMasterWork: number };
    },
    workBinding: { path: string; sizeBytes: number; sha256: string },
  ) => {
    sourceBoundary: { files: unknown[]; fileCount: number };
    workBoundary: {
      files: unknown[];
      fileCount: number;
      recordsRead: number;
      excludedWorkCount: number;
    };
  };
};

const strict =
  require("../scripts/library-full-pipeline-qa/strict-baseline-selection.cjs") as StrictSelectionModule;
const builder =
  require("../scripts/build-library-full-pipeline-font-qa-v11.cjs") as RunnerBuilderModule;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("library full-pipeline v11 strict baseline", () => {
  it("emits the exact cohort and boundary keys consumed by the QA runner", () => {
    const cohort = builder.runnerCohortDetails(
      {
        path: "C:\\qa\\baseline40.jsonl",
        sizeBytes: 123,
        sha256: "a".repeat(64),
      },
      "b".repeat(64),
      { pages: 40 },
    );
    const sourceBoundary = emptyBoundary();
    sourceBoundary.files.push({
      path: "C:\\qa\\prior.jsonl",
      sizeBytes: 10,
      sha256: "c".repeat(64),
      recordsRead: 1,
    });
    sourceBoundary.recordsRead = 1;
    const boundaries = builder.buildRunnerBoundaryContract(
      {
        sourceBoundary: sourceBoundary as SourceBoundary & {
          files: Array<{
            path: string;
            sizeBytes: number;
            sha256: string;
            recordsRead: number;
          }>;
        },
        workBoundary: { workIds: new Set(["work-a", "work-b"]) },
        stats: { excludedByMasterWork: 12 },
      },
      {
        path: "C:\\qa\\work-union.jsonl",
        sizeBytes: 20,
        sha256: "d".repeat(64),
      },
    );

    expect(cohort.manifestPath).toBe(cohort.path);
    expect(cohort.manifestSha256).toBe("b".repeat(64));
    expect(boundaries.sourceBoundary.fileCount).toBe(1);
    expect(boundaries.sourceBoundary.files).toHaveLength(1);
    expect(boundaries.workBoundary).toMatchObject({
      fileCount: 1,
      recordsRead: 2,
      excludedWorkCount: 2,
    });
  });

  it("recursively extracts only source-page identities and normalizes library paths", () => {
    const boundary = emptyBoundary();
    strict.collectSourcePageIdentities(
      {
        rows: [
          {
            work_id: "work-a",
            page_id: "page-a",
            source_page_sha256: "a".repeat(64),
          },
          {
            work: { id: "work-b" },
            page: {
              id: "page-b",
              imagePath: "C:\\repo\\library\\works\\work-b\\page.png",
              imageSha256: "b".repeat(64),
              source_locator: {
                path: "works/work-b/page.png",
                file_sha256: "b".repeat(64),
              },
            },
          },
        ],
        model_sha256: "c".repeat(64),
      },
      boundary,
    );

    expect([...boundary.pageIds].sort()).toEqual(["page-a", "page-b"]);
    expect([...boundary.referencedWorkIds].sort()).toEqual([
      "work-a",
      "work-b",
    ]);
    expect(boundary.relativePaths).toEqual(new Set(["works/work-b/page.png"]));
    expect(boundary.sourcePageSha256s).toEqual(
      new Set(["a".repeat(64), "b".repeat(64)]),
    );
    expect(boundary.sourcePageSha256s.has("c".repeat(64))).toBe(false);
  });

  it("hard-denies the current v10 holdout before any read", () => {
    expect(() =>
      strict.assertNotCurrentV10Holdout(
        "C:/repo/artifacts/library-full-pipeline-font-qa-v10/cohorts/holdout40.jsonl",
      ),
    ).toThrow(/forbidden input/);
    expect(() =>
      strict.assertNotCurrentV10Holdout(
        "C:/repo/artifacts/library-full-pipeline-font-qa-v10/cohorts/baseline40.jsonl",
      ),
    ).not.toThrow();
  });

  it("builds the exact train/val/test work union from master rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "font-v11-work-union-"));
    temporaryRoots.push(root);
    const manifest = join(root, "manifest.jsonl");
    writeFileSync(
      manifest,
      [
        masterRow("work-a", "chapter-a", "page-a", "train"),
        masterRow("work-a", "chapter-b", "page-b", "val"),
        masterRow("work-b", "chapter-c", "page-c", "test"),
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
      "utf8",
    );

    const union = await strict.scanMasterWorkUnion(manifest);

    expect(union.workIds).toEqual(new Set(["work-a", "work-b"]));
    expect(union.recordsRead).toBe(3);
    expect(union.splitRows).toEqual({ train: 1, val: 1, test: 1 });
    expect(union.works.get("work-a")?.pageIds.size).toBe(2);
    expect(union.works.get("work-a")?.chapterIds.size).toBe(2);
  });

  it("maximizes work coverage and reaches 40 distinct chapters under max five", () => {
    const candidates = buildDiversityCandidates();
    const first = strict.selectStrictBaseline(candidates, {
      seed: "v11-fixed-seed",
      target: 40,
      maxPagesPerWork: 5,
    });
    const second = strict.selectStrictBaseline(candidates, {
      seed: "v11-fixed-seed",
      target: 40,
      maxPagesPerWork: 5,
    });
    const workCounts = countBy(first, (item) => item.workId);

    expect(first.map((item) => item.pageId)).toEqual(
      second.map((item) => item.pageId),
    );
    expect(first).toHaveLength(40);
    expect(workCounts.size).toBe(10);
    expect(Math.max(...workCounts.values())).toBe(5);
    expect(
      new Set(first.map((item) => `${item.workId}:${item.chapterId}`)).size,
    ).toBe(40);
  });

  it("reports work, id, path, and SHA overlap independently", () => {
    const boundary = emptyBoundary();
    boundary.pageIds.add("page-id-overlap");
    boundary.relativePaths.add("works/path-overlap.png");
    boundary.sourcePageSha256s.add("d".repeat(64));
    const proof = strict.validateStrictBaselineRecords(
      [
        frozenRecord(
          "master-work",
          "chapter-1",
          "page-1",
          "works/one.png",
          "1",
        ),
        frozenRecord(
          "safe",
          "chapter-2",
          "page-id-overlap",
          "works/two.png",
          "2",
        ),
        frozenRecord(
          "safe",
          "chapter-3",
          "page-3",
          "works/path-overlap.png",
          "3",
        ),
        frozenRecord("safe", "chapter-4", "page-4", "works/four.png", "d"),
      ],
      {
        target: 4,
        maxPagesPerWork: 5,
        workIds: new Set(["master-work"]),
        sourceBoundary: boundary,
      },
    );

    expect(proof.errors.join("\n")).toMatch(/master work overlap/);
    expect(proof.errors.join("\n")).toMatch(/page-id overlap/);
    expect(proof.errors.join("\n")).toMatch(/page-path overlap/);
    expect(proof.errors.join("\n")).toMatch(/page-sha overlap/);
  });
});

function emptyBoundary(): SourceBoundary {
  return {
    pageIds: new Set(),
    relativePaths: new Set(),
    sourcePageSha256s: new Set(),
    referencedWorkIds: new Set(),
    files: [],
    recordsRead: 0,
  };
}

function masterRow(
  workId: string,
  chapterId: string,
  pageId: string,
  split: "train" | "val" | "test",
) {
  return {
    work: { id: workId, title: workId },
    chapter: { id: chapterId },
    page: { id: pageId },
    split,
  };
}

function buildDiversityCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  for (let workIndex = 0; workIndex < 10; workIndex += 1) {
    const chapterCount = workIndex < 2 ? 1 : 6;
    for (let chapterIndex = 0; chapterIndex < chapterCount; chapterIndex += 1) {
      for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
        candidates.push({
          workId: `work-${workIndex}`,
          chapterId: `chapter-${workIndex}-${chapterIndex}`,
          pageId: `page-${workIndex}-${chapterIndex}-${pageIndex}`,
          imageRelativePath: `works/${workIndex}/${chapterIndex}/${pageIndex}.png`,
          variantSignalCount: pageIndex,
          variantSignals: { strongTotal: pageIndex },
        });
      }
    }
  }
  return candidates;
}

function countBy<T>(items: T[], key: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function frozenRecord(
  workId: string,
  chapterId: string,
  pageId: string,
  imageRelativePath: string,
  shaPrefix: string,
) {
  return {
    work: { id: workId },
    chapter: { id: chapterId },
    page: {
      id: pageId,
      imageRelativePath,
      imageSha256: shaPrefix.repeat(64).slice(0, 64),
    },
  };
}
