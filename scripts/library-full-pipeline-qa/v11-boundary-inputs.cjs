const path = require("node:path");

/**
 * Explicit, reviewable source-page authority inventory for v11. The current
 * v10 holdout is intentionally absent and independently hard-denied by the
 * strict scanner.
 * @param {string} repositoryRoot
 */
function v11BoundaryGroups(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  /** @param {...string} segments */
  const artifact = (...segments) => path.join(root, "artifacts", ...segments);
  const priorQaV1ThroughV9 = [];
  for (let version = 1; version <= 9; version += 1) {
    for (const cohort of ["baseline40", "holdout40"]) {
      priorQaV1ThroughV9.push(
        artifact(
          `library-full-pipeline-font-qa-v${version}`,
          "cohorts",
          `${cohort}.jsonl`,
        ),
      );
    }
  }
  return [
    {
      category: "prior-qa-v1-v9-used-cohorts",
      paths: priorQaV1ThroughV9,
    },
    {
      category: "prior-qa-v10-used-baseline-only",
      paths: [
        artifact(
          "library-full-pipeline-font-qa-v10",
          "cohorts",
          "baseline40.jsonl",
        ),
      ],
    },
    {
      category: "legacy-training-source-pages",
      paths: [
        artifact(
          "font-matching-training-export-full22-strict-v1",
          ".font-matching-training-export-owned.json",
        ),
        artifact(
          "font-matching-training-export-full22-strict-v1",
          "manifest.json",
        ),
        artifact(
          "font-matching-training-export-full22-strict-v1",
          "resolved-labels-full22.jsonl",
        ),
        artifact(
          "font-matching-training-export-full22-strict-v1",
          "retrieval.jsonl",
        ),
      ],
    },
    {
      category: "fresh-evaluation-source-pages",
      paths: [artifact("manga-font-fresh-eval-cohort-v1", "cohort.jsonl")],
    },
    {
      category: "human-val33-source-pages",
      paths: [
        artifact(
          "manga-font-student-human-overlay-adjudicated-val33-v1",
          "val-samples-adjudicated.jsonl",
        ),
      ],
    },
    {
      category: "blind-calibration-private-source-bindings",
      paths: [
        artifact(
          "manga-font-v2-independent-blind-calibration-eval-pool-r1",
          "private-bindings.jsonl",
        ),
        artifact(
          "manga-font-v2-independent-blind-calibration-eval-pool-r2",
          "private-bindings.jsonl",
        ),
      ],
    },
    {
      category: "high-value-label-private-source-bindings",
      paths: [
        artifact(
          "manga-font-v2-high-value-supervised-queue-r1-800",
          "private-bindings.jsonl",
        ),
        artifact(
          "manga-font-v2-high-value-supervised-queue-r2-801-1600-training-only-r1",
          "private-bindings.jsonl",
        ),
      ],
    },
    {
      category: "qa-label-private-source-bindings",
      paths: [
        artifact(
          "manga-font-v2-baseline40-r3h-r4a25-development-correction-blind-r1",
          "private-deblind-binding.json",
        ),
      ],
    },
  ];
}

/** @param {string} repositoryRoot */
function currentV10HoldoutPath(repositoryRoot) {
  return path.join(
    path.resolve(repositoryRoot),
    "artifacts",
    "library-full-pipeline-font-qa-v10",
    "cohorts",
    "holdout40.jsonl",
  );
}

module.exports = { currentV10HoldoutPath, v11BoundaryGroups };
