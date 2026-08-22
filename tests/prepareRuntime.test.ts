import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type PrepareRuntimeModule = {
  prepareRuntimeAssets: (options: {
    root: string;
    outputDir?: string;
    fontMatchingBundleDir?: string;
    runtimeModulesOnly?: boolean;
  }) => string;
  resolveDefaultFontMatchingRuntimeBundleDir: (root: string) => string;
  validatePackagedFontMatchingRuntimeBundle: (bundleDir: string) => void;
};

const {
  prepareRuntimeAssets,
  resolveDefaultFontMatchingRuntimeBundleDir,
  validatePackagedFontMatchingRuntimeBundle,
} = require("../scripts/prepare-runtime.cjs") as PrepareRuntimeModule;

const temporaryDirectories: string[] = [];
const RUNTIME_SCHEMA_V1 = "font-matching-runtime-artifact-v1";
const RUNTIME_SCHEMA_V2 = "font-matching-runtime-artifact-v2";
const RUNTIME_OWNER_V1 =
  "carrot-manga-translator/font-matching-runtime-artifact";
const RUNTIME_OWNER_V2 =
  "carrot-manga-translator/font-matching-runtime-artifact-v2";
const VALID_HYBRID_SCORE_ROUTING = {
  schema_version: "font-matching-hybrid-score-routing-v1",
  candidate_scores_compatibility_alias: "body_candidate_scores",
  body_candidate_output: "body_candidate_scores",
  variant_candidate_output: "variant_candidate_scores",
  body_roles: ["dialogue", "narration", "thought"],
  variant_roles: [
    "whisper",
    "aside_balloon_edge",
    "emphasis_dialogue",
    "shout",
    "sfx_impact",
    "sfx_motion",
    "sfx_ambient",
    "sfx_emotion",
    "sfx_comic",
    "sign_ui_title",
    "other",
  ],
  unknown_role_fallback: "variant_candidate_scores",
  role_source: "resolveCombinedAutomaticFontRole(item.fontRole,pixelRole)",
  selection_feature_source:
    "selected_candidate_scores_with_legacy256_visual_features",
  selection_feature_dim: 256,
  row_specific_rules: false,
};
const VALID_HYBRID_BATCHING = {
  encoder_batch_size: 2,
  ranker_batch_size: 16,
  parity_qualified: true,
};

function sealedLegacyReleaseAcceptance(): Record<string, unknown> {
  const acceptance: Record<string, unknown> = {
    record_type: "font_matching_runtime_release_acceptance",
    schema_version: "font-matching-runtime-release-acceptance-v1",
    status: "accepted",
    external_release_quality_gate_passed: true,
    automatic_visual_judgment: false,
    quality_gate: {
      structural_error_count: 0,
      manual_page_verdicts: { accepted: 80, total: 80 },
    },
  };
  acceptance.record_sha256 = createHash("sha256")
    .update(canonicalJson(acceptance))
    .digest("hex");
  return acceptance;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    removeDirectoryTree(directory);
  }
});

function removeDirectoryTree(directory: string): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removeDirectoryTree(entryPath);
      continue;
    }
    unlinkSync(entryPath);
  }
  rmdirSync(directory);
}

function createRuntimeFixture(options: { withDefaultBundle?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "prepare-runtime-"));
  temporaryDirectories.push(root);
  const sourceDir = join(root, "src", "main", "runtime");
  mkdirSync(join(sourceDir, "transport"), { recursive: true });
  mkdirSync(join(sourceDir, "templates"), { recursive: true });
  writeFileSync(join(sourceDir, "root.cjs"), "root");
  writeFileSync(join(sourceDir, "runtime-jsdoc-types.d.ts"), "types");
  writeFileSync(
    join(sourceDir, "requirements-runtime.in"),
    "build-only lock input",
  );
  writeFileSync(
    join(sourceDir, "paddleocr_review_contexts.py"),
    "def build_textline_review_context_ids(partition): return {}",
  );
  writeFileSync(join(sourceDir, "transport", "response.cjs"), "nested");
  writeFileSync(join(sourceDir, "transport", "stale.pyc"), "bytecode");
  writeFileSync(join(sourceDir, "transport", "stale.pyo"), "bytecode");
  writeFileSync(join(sourceDir, "templates", "chat-template.jinja"), "jinja");
  mkdirSync(join(sourceDir, "__pycache__"), { recursive: true });
  writeFileSync(
    join(sourceDir, "__pycache__", "runtime.cpython-312.pyc"),
    "bytecode",
  );
  if (options.withDefaultBundle !== false) {
    createFontMatchingBundle(root);
  }
  return { root, sourceDir };
}

function createFontMatchingBundle(
  root: string,
  options: {
    schemaVersion?: typeof RUNTIME_SCHEMA_V1 | typeof RUNTIME_SCHEMA_V2;
    owner?: string;
    directoryName?: string;
    contractOverrides?: Record<string, unknown>;
    markerOverrides?: Record<string, unknown>;
  } = {},
): string {
  const schemaVersion = options.schemaVersion ?? RUNTIME_SCHEMA_V2;
  const bundleDir = join(
    root,
    "artifacts",
    options.directoryName ??
      "font-matching-runtime-active21-v9-r33-page-common-user-v3-release-v2",
  );
  mkdirSync(bundleDir, { recursive: true });
  const runtimeContract: Record<string, unknown> = {
    record_type: "font_matching_runtime_artifact",
    schema_version: schemaVersion,
    ...(schemaVersion === RUNTIME_SCHEMA_V2
      ? {
          hybrid_score_routing: VALID_HYBRID_SCORE_ROUTING,
          runtime_batching: VALID_HYBRID_BATCHING,
          release_acceptance: sealedLegacyReleaseAcceptance(),
        }
      : {}),
    ...options.contractOverrides,
  };
  const artifacts: Record<string, string> = {};
  for (const fileName of [
    "auto-match-active-catalog.json",
    "encoder.onnx",
    "prototype-features.f32",
    "ranker.onnx",
    "selection-calibration.json",
  ]) {
    const bytes = Buffer.from(`sealed:${fileName}`);
    writeFileSync(join(bundleDir, fileName), bytes);
    artifacts[fileName] = createHash("sha256").update(bytes).digest("hex");
  }
  const contractBytes = Buffer.from(JSON.stringify(runtimeContract));
  writeFileSync(join(bundleDir, "runtime-contract.json"), contractBytes);
  artifacts["runtime-contract.json"] = createHash("sha256")
    .update(contractBytes)
    .digest("hex");
  writeFileSync(
    join(bundleDir, ".font-matching-runtime-artifact-owned.json"),
    JSON.stringify({
      owner:
        options.owner ??
        (schemaVersion === RUNTIME_SCHEMA_V2
          ? RUNTIME_OWNER_V2
          : RUNTIME_OWNER_V1),
      schema_version: schemaVersion,
      safe_replace: true,
      artifacts,
      ...options.markerOverrides,
    }),
  );
  return bundleDir;
}

describe("prepareRuntimeAssets", () => {
  it("replaces stale output and recursively copies runtime modules", () => {
    const { root } = createRuntimeFixture();
    const outputDir = join(root, "out", "app-runtime");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "stale.cjs"), "stale");

    expect(prepareRuntimeAssets({ root, outputDir })).toBe(outputDir);

    expect(existsSync(join(outputDir, "stale.cjs"))).toBe(false);
    expect(readFileSync(join(outputDir, "root.cjs"), "utf8")).toBe("root");
    expect(
      readFileSync(join(outputDir, "paddleocr_review_contexts.py"), "utf8"),
    ).toContain("build_textline_review_context_ids");
    expect(
      readFileSync(join(outputDir, "transport", "response.cjs"), "utf8"),
    ).toBe("nested");
    expect(
      readFileSync(join(outputDir, "templates", "chat-template.jinja"), "utf8"),
    ).toBe("jinja");
  });

  it("omits development declarations, lock inputs, and Python bytecode caches", () => {
    const { root, sourceDir } = createRuntimeFixture();
    const outputDir = join(root, "out", "app-runtime");

    prepareRuntimeAssets({ root, outputDir });

    expect(existsSync(join(outputDir, "runtime-jsdoc-types.d.ts"))).toBe(false);
    expect(existsSync(join(outputDir, "requirements-runtime.in"))).toBe(false);
    expect(existsSync(join(outputDir, "transport", "stale.pyc"))).toBe(false);
    expect(existsSync(join(outputDir, "transport", "stale.pyo"))).toBe(false);
    expect(existsSync(join(outputDir, "__pycache__"))).toBe(false);
    expect(existsSync(join(sourceDir, "runtime-jsdoc-types.d.ts"))).toBe(true);
    expect(existsSync(join(sourceDir, "requirements-runtime.in"))).toBe(true);
    expect(existsSync(join(sourceDir, "transport", "stale.pyc"))).toBe(true);
    expect(existsSync(join(sourceDir, "transport", "stale.pyo"))).toBe(true);
    expect(existsSync(join(sourceDir, "__pycache__"))).toBe(true);
  });

  it("refuses to clean the project root or any runtime source path", () => {
    const { root, sourceDir } = createRuntimeFixture();

    expect(() => prepareRuntimeAssets({ root, outputDir: root })).toThrow(
      /unsafe runtime output/,
    );
    expect(() => prepareRuntimeAssets({ root, outputDir: sourceDir })).toThrow(
      /unsafe runtime output/,
    );
    expect(() =>
      prepareRuntimeAssets({ root, outputDir: join(root, "src", "main") }),
    ).toThrow(/unsafe runtime output/);

    expect(readFileSync(join(sourceDir, "root.cjs"), "utf8")).toBe("root");
  });

  it("does not replace a non-directory output target", () => {
    const { root } = createRuntimeFixture();
    const outputFile = join(root, "runtime-output");
    writeFileSync(outputFile, "keep-me");

    expect(() => prepareRuntimeAssets({ root, outputDir: outputFile })).toThrow(
      /must be a real directory/,
    );
    expect(readFileSync(outputFile, "utf8")).toBe("keep-me");
  });

  it("keeps runtime modules when the optional full bundle source is absent", () => {
    const { root } = createRuntimeFixture({ withDefaultBundle: false });
    const outputDir = join(root, "out", "app-runtime");

    expect(resolveDefaultFontMatchingRuntimeBundleDir(root)).toBe(
      join(
        root,
        "artifacts",
        "font-matching-runtime-active21-v9-r33-page-common-user-v3-release-v2",
      ),
    );
    // A missing optional development bundle must not break a fresh CI build;
    // packaged apps obtain every font runtime asset from the external cache.
    expect(() => prepareRuntimeAssets({ root, outputDir })).not.toThrow();
    expect(readFileSync(join(outputDir, "root.cjs"), "utf8")).toBe("root");
    expect(existsSync(join(outputDir, "font-matching"))).toBe(false);
  });

  it("allows the full-pipeline QA harness to stage runtime modules only", () => {
    const { root } = createRuntimeFixture({ withDefaultBundle: false });
    const outputDir = join(root, "out", "app-runtime");

    expect(() =>
      prepareRuntimeAssets({ root, outputDir, runtimeModulesOnly: true }),
    ).not.toThrow();
    expect(readFileSync(join(outputDir, "root.cjs"), "utf8")).toBe("root");
    expect(existsSync(join(outputDir, "font-matching"))).toBe(false);
  });

  it("stages the default sealed schema-v2 release-v1 bundle", () => {
    const { root } = createRuntimeFixture();
    const bundleDir = createFontMatchingBundle(root);
    const outputDir = join(root, "out", "app-runtime");

    prepareRuntimeAssets({ root, outputDir });

    const stagedDir = join(outputDir, "font-matching");
    expect(readdirSync(stagedDir).sort()).toEqual(
      readdirSync(bundleDir).sort(),
    );
    expect(readFileSync(join(stagedDir, "ranker.onnx"), "utf8")).toBe(
      "sealed:ranker.onnx",
    );
    expect(
      readFileSync(join(stagedDir, "selection-calibration.json"), "utf8"),
    ).toBe("sealed:selection-calibration.json");
    const stagedMarker = JSON.parse(
      readFileSync(
        join(stagedDir, ".font-matching-runtime-artifact-owned.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(stagedMarker.schema_version).toBe(RUNTIME_SCHEMA_V2);
    expect(stagedMarker.owner).toBe(RUNTIME_OWNER_V2);
  });

  it("continues to accept an explicitly selected sealed schema-v1 bundle", () => {
    const { root } = createRuntimeFixture();
    const bundleDir = createFontMatchingBundle(root, {
      schemaVersion: RUNTIME_SCHEMA_V1,
      directoryName: "font-matching-runtime-v1-compatibility-fixture",
    });
    const outputDir = join(root, "out", "app-runtime");

    prepareRuntimeAssets({ root, outputDir, fontMatchingBundleDir: bundleDir });

    expect(
      JSON.parse(
        readFileSync(
          join(
            outputDir,
            "font-matching",
            ".font-matching-runtime-artifact-owned.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({
      schema_version: RUNTIME_SCHEMA_V1,
      owner: RUNTIME_OWNER_V1,
    });
  });

  it("stages an explicitly selected calibrated hybrid v2 bundle", () => {
    const { root } = createRuntimeFixture();
    const bundleDir = createFontMatchingBundle(root, {
      schemaVersion: RUNTIME_SCHEMA_V2,
      directoryName: "font-matching-runtime-hybrid-calibrated-fixture",
    });
    const outputDir = join(root, "out", "app-runtime");

    prepareRuntimeAssets({ root, outputDir, fontMatchingBundleDir: bundleDir });

    const stagedMarker = JSON.parse(
      readFileSync(
        join(
          outputDir,
          "font-matching",
          ".font-matching-runtime-artifact-owned.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(stagedMarker.schema_version).toBe(RUNTIME_SCHEMA_V2);
    expect(stagedMarker.owner).toBe(RUNTIME_OWNER_V2);
  });

  it.each([
    [RUNTIME_SCHEMA_V1, RUNTIME_OWNER_V2],
    [RUNTIME_SCHEMA_V2, RUNTIME_OWNER_V1],
  ] as const)(
    "rejects a mismatched %s owner/schema pair",
    (schemaVersion, owner) => {
      const { root } = createRuntimeFixture();
      const bundleDir = createFontMatchingBundle(root, {
        schemaVersion,
        owner,
        directoryName: "font-matching-runtime-owner-mismatch",
      });

      expect(() =>
        prepareRuntimeAssets({
          root,
          outputDir: join(root, "out", "app-runtime"),
          fontMatchingBundleDir: bundleDir,
        }),
      ).toThrow(/ownership marker is invalid/);
    },
  );

  it("rejects a v2 marker/contract schema mismatch", () => {
    const { root } = createRuntimeFixture();
    const bundleDir = createFontMatchingBundle(root, {
      schemaVersion: RUNTIME_SCHEMA_V2,
      directoryName: "font-matching-runtime-schema-mismatch",
      contractOverrides: { schema_version: RUNTIME_SCHEMA_V1 },
    });

    expect(() =>
      prepareRuntimeAssets({
        root,
        outputDir: join(root, "out", "app-runtime"),
        fontMatchingBundleDir: bundleDir,
      }),
    ).toThrow(/marker\/contract schema is invalid/);
  });

  it("rejects drift in the exact hybrid score-routing contract", () => {
    const { root } = createRuntimeFixture();
    const bundleDir = createFontMatchingBundle(root, {
      schemaVersion: RUNTIME_SCHEMA_V2,
      directoryName: "font-matching-runtime-routing-drift",
      contractOverrides: {
        hybrid_score_routing: {
          ...VALID_HYBRID_SCORE_ROUTING,
          role_source: "pixelRole",
        },
      },
    });

    expect(() =>
      prepareRuntimeAssets({
        root,
        outputDir: join(root, "out", "app-runtime"),
        fontMatchingBundleDir: bundleDir,
      }),
    ).toThrow(/hybrid score routing is invalid/);
  });

  it("rejects drift in parity-qualified hybrid runtime batching", () => {
    const { root } = createRuntimeFixture();
    const bundleDir = createFontMatchingBundle(root, {
      schemaVersion: RUNTIME_SCHEMA_V2,
      directoryName: "font-matching-runtime-batching-drift",
      contractOverrides: {
        runtime_batching: {
          ...VALID_HYBRID_BATCHING,
          ranker_batch_size: 8,
        },
      },
    });

    expect(() =>
      prepareRuntimeAssets({
        root,
        outputDir: join(root, "out", "app-runtime"),
        fontMatchingBundleDir: bundleDir,
      }),
    ).toThrow(/runtime batching is invalid/);
  });

  it("rejects an unaccepted production v2 runtime before staging", () => {
    const { root } = createRuntimeFixture();
    const bundleDir = createFontMatchingBundle(root, {
      schemaVersion: RUNTIME_SCHEMA_V2,
      directoryName: "font-matching-runtime-unaccepted-v2",
      contractOverrides: { release_acceptance: undefined },
    });

    expect(() =>
      prepareRuntimeAssets({
        root,
        outputDir: join(root, "out", "app-runtime"),
        fontMatchingBundleDir: bundleDir,
      }),
    ).toThrow(/release acceptance is invalid/);
  });

  it("rejects QA-only runtime markers before packaging", () => {
    const { root } = createRuntimeFixture();
    const bundleDir = createFontMatchingBundle(root, {
      schemaVersion: RUNTIME_SCHEMA_V2,
      directoryName: "font-matching-runtime-qa-only",
      markerOverrides: { qa_only: true, release_approved: false },
    });

    expect(() =>
      prepareRuntimeAssets({
        root,
        outputDir: join(root, "out", "app-runtime"),
        fontMatchingBundleDir: bundleDir,
      }),
    ).toThrow(/QA-only runtime bundles cannot be packaged or deployed/);
  });

  it("accepts only a sealed schema-v2 release bundle for packaged output", () => {
    const { root } = createRuntimeFixture();
    const releaseBundle = resolveDefaultFontMatchingRuntimeBundleDir(root);

    expect(() =>
      validatePackagedFontMatchingRuntimeBundle(releaseBundle),
    ).not.toThrow();

    const v1Bundle = createFontMatchingBundle(root, {
      schemaVersion: RUNTIME_SCHEMA_V1,
      directoryName: "font-matching-runtime-v1-packaging-reject",
    });
    expect(() => validatePackagedFontMatchingRuntimeBundle(v1Bundle)).toThrow(
      /schema-v2 release contract/,
    );

    const qaOnlyBundle = createFontMatchingBundle(root, {
      directoryName: "font-matching-runtime-qa-only-packaging-reject",
      markerOverrides: { qa_only: true, release_approved: false },
    });
    expect(() =>
      validatePackagedFontMatchingRuntimeBundle(qaOnlyBundle),
    ).toThrow(/QA-only runtime bundles cannot be packaged or deployed/);

    expect(() =>
      validatePackagedFontMatchingRuntimeBundle(
        join(root, "artifacts", "missing-packaged-runtime"),
      ),
    ).toThrow(/Packaged font matching runtime is missing/);
  });

  it("fails closed instead of staging a hash-mismatched bundle", () => {
    const { root } = createRuntimeFixture();
    const bundleDir = createFontMatchingBundle(root);
    const outputDir = join(root, "out", "app-runtime");
    writeFileSync(join(bundleDir, "ranker.onnx"), "tampered");

    expect(() => prepareRuntimeAssets({ root, outputDir })).toThrow(
      /artifact hash mismatch: ranker\.onnx/,
    );
    expect(existsSync(join(outputDir, "font-matching"))).toBe(false);
  });

  it("requires an explicitly selected bundle to exist", () => {
    const { root } = createRuntimeFixture();
    const outputDir = join(root, "out", "app-runtime");

    expect(() =>
      prepareRuntimeAssets({
        root,
        outputDir,
        fontMatchingBundleDir: join(root, "artifacts", "missing-bundle"),
      }),
    ).toThrow(/runtime bundle is missing/);
  });
});
