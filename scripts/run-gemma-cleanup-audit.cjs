#!/usr/bin/env node
// @ts-check

const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { ensureElectronExecutable } = require("./electron-executable.cjs");
const {
  synchronizeQaRuntimeAssets,
} = require("./library-full-pipeline-qa/runtime-assets-preflight.cjs");
const {
  assertExactTwoImageMessages,
  INTEGRITY_SCOPE,
  sha256Canonical,
} = require("./library-full-pipeline-qa/gemma-cleanup-audit-contract.cjs");
const {
  assertShadowRuntimeTargets,
  assertShadowWriteTargets,
  loadFrozenAuditInputs,
  loadFrozenManifest,
} = require("./library-full-pipeline-qa/gemma-cleanup-audit-inputs.cjs");
const {
  prepareAuditPage,
  readExperimentReport,
  validateExperimentArtifacts,
} = require("./library-full-pipeline-qa/gemma-cleanup-audit-runner.cjs");
const {
  buildPreflightRuntimeBinding,
  buildAuditRunPaths,
  validateLiveRuntimeBindingFiles,
} = require("./library-full-pipeline-qa/gemma-cleanup-audit-runtime.cjs");

const ROOT = path.resolve(__dirname, "..");
const ELECTRON_RUNNER = path.join(
  __dirname,
  "library-full-pipeline-qa",
  "gemma-cleanup-audit-electron-runner.cjs",
);
const DEFAULT_CACHE = path.join(ROOT, ".tmp", "gemma-cleanup-audit-cache-v1");

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === "help") return printHelp();
  if (parsed.command === "preflight") return preflightCommand(parsed.options);
  if (parsed.command === "validate") return validateCommand(parsed.options);
  if (parsed.command === "run") return runCommand(parsed.options);
  throw new Error(`Unknown cleanup audit command: ${parsed.command}`);
}

/** @param {Record<string,string|boolean>} options */
async function preflightCommand(options) {
  const loadedManifest = await loadFrozenManifest(ROOT);
  const indices = resolveIndices(options, loadedManifest.manifest);
  const inputs = await loadFrozenAuditInputs({ root: ROOT, indices });
  const runtimeBinding = buildPreflightRuntimeBinding(inputs.manifest.model);
  const pages = inputs.pages.map((page) => {
    const prepared = prepareAuditPage({
      page: /** @type {any} */ (page),
      modelName: inputs.manifest.model.repo,
      runtimeBinding,
    });
    assertExactTwoImageMessages(
      /** @type {any} */ (prepared.knownBlockInitialRequestBody.messages),
    );
    assertExactTwoImageMessages(
      /** @type {any} */ (prepared.unassignedInitialRequestBody.messages),
    );
    return {
      selectionIndex: page.selectionIndex,
      pageId: page.pageId,
      expectedClass: page.expectedClass,
      blockCount: page.blocks.length,
      exactImageCount: 2,
      imageOrder: ["Image1:original", "Image2:cleaned"],
      originalSha256: page.original.sourceSha256,
      cleanedSha256: page.cleaned.sourceSha256,
      orderedBlockIdsSha256: page.orderedBlockIdsSha256,
      passOrder: ["known-block", "unassigned-source"],
      unassignedExecutionGate: "known-block-clean-only",
      knownBlockInitialRequestBodySha256: sha256Canonical(
        prepared.knownBlockInitialRequestBody,
      ),
      unassignedInitialRequestBodySha256: sha256Canonical(
        prepared.unassignedInitialRequestBody,
      ),
      inputBindingSha256: prepared.inputBinding.bindingSha256,
      liveInferenceExecuted: false,
    };
  });
  console.log(
    JSON.stringify(
      {
        contractVersion: inputs.manifest.contractVersion,
        shadowOnly: true,
        promotionEligible: false,
        evaluationRole: inputs.manifest.evaluationRole,
        holdoutEligible: inputs.manifest.holdoutEligible,
        productionMutationAllowed: false,
        integrityScope: INTEGRITY_SCOPE,
        frozenManifestSha256: inputs.manifestSha256,
        runReportSha256: inputs.runReportSha256,
        pageCount: pages.length,
        pages,
      },
      null,
      2,
    ),
  );
}

/** @param {Record<string,string|boolean>} options */
async function validateCommand(options) {
  const outputRoot = requiredPathOption(options.output, "--output");
  const untrustedReport = await readExperimentReport(outputRoot);
  const indices = Array.isArray(untrustedReport.expectedSelectionIndices)
    ? untrustedReport.expectedSelectionIndices.map((value) => Number(value))
    : [];
  const inputs = await loadFrozenAuditInputs({ root: ROOT, indices });
  await validateExperimentArtifacts(outputRoot, {
    authoritativeInputs: inputs,
    allowPartial: options["allow-partial"] === true,
    runtimeVerifier: validateLiveRuntimeBindingFiles,
  });
  console.log(
    `[cleanup-audit] validated ${indices.length} sealed page artifact(s): ${path.resolve(outputRoot)}`,
  );
}

/** @param {Record<string,string|boolean>} options */
async function runCommand(options) {
  if (options.execute !== true) {
    throw new Error("Live Gemma audit requires the explicit --execute flag.");
  }
  const outputRoot = requiredPathOption(options.output, "--output");
  const cacheDir = path.resolve(String(options.cache || DEFAULT_CACHE));
  const loadedManifest = await loadFrozenManifest(ROOT);
  const indices = resolveIndices(options, loadedManifest.manifest);
  const frozenInputs = await loadFrozenAuditInputs({ root: ROOT, indices });
  await assertShadowWriteTargets({
    root: ROOT,
    runRoot: frozenInputs.runRoot,
    outputRoot,
    cacheDir,
  });
  const runId = randomUUID();
  await assertShadowRuntimeTargets({
    root: ROOT,
    ...buildAuditRunPaths(ROOT, runId),
  });
  runChecked(process.execPath, [
    path.join(ROOT, "scripts", "compile-electron.cjs"),
  ]);
  synchronizeQaRuntimeAssets(ROOT);
  const electron = ensureElectronExecutable(ROOT);
  const config = {
    root: ROOT,
    indices,
    outputRoot,
    cacheDir,
    runId,
  };
  const result = spawnSync(electron, [ELECTRON_RUNNER], {
    cwd: ROOT,
    env: {
      ...process.env,
      MGT_GEMMA_CLEANUP_AUDIT_CONFIG: JSON.stringify(config),
    },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Cleanup audit Electron runner failed with exit code ${result.status ?? "null"}.`,
    );
  }
}

/** @param {string[]} args */
function parseArguments(args) {
  const command = args[0] || "help";
  if (command === "--help" || command === "-h") {
    if (args.length !== 1)
      throw new Error("--help accepts no extra arguments.");
    return { command: "help", options: {} };
  }
  /** @type {Record<string,Set<string>>} */
  const allowedByCommand = {
    help: new Set(),
    preflight: new Set(["index", "indices", "all"]),
    run: new Set(["index", "indices", "all", "execute", "output", "cache"]),
    validate: new Set(["output", "allow-partial"]),
  };
  if (!Object.hasOwn(allowedByCommand, command)) {
    throw new Error(`Unknown cleanup audit command: ${command}`);
  }
  /** @type {Record<string,string|boolean>} */
  const options = {};
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--help" || token === "-h") {
      if (args.length !== 2)
        throw new Error("--help accepts no extra arguments.");
      return { command: "help", options: {} };
    }
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected cleanup audit argument: ${token}`);
    }
    const key = token.slice(2);
    if (!allowedByCommand[command].has(key)) {
      throw new Error(`Unknown option for ${command}: ${token}`);
    }
    if (Object.hasOwn(options, key)) {
      throw new Error(`Duplicate cleanup audit option: ${token}`);
    }
    if (["all", "execute", "allow-partial"].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Cleanup audit option ${token} requires a value.`);
    }
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

/** @param {Record<string,string|boolean>} options @param {{pages:Array<{selectionIndex:number}>}} manifest */
function resolveIndices(options, manifest) {
  if (options.all === true) {
    if (options.index || options.indices) {
      throw new Error("--all cannot be combined with --index/--indices.");
    }
    return manifest.pages.map((page) => page.selectionIndex);
  }
  if (options.index && options.indices) {
    throw new Error("Use either --index or --indices, not both.");
  }
  if (typeof options.index === "string" && options.index.includes(",")) {
    throw new Error("--index accepts one integer; use --indices for a list.");
  }
  const raw = String(options.index || options.indices || "14");
  const indices = raw.split(",").map((value) => Number(value.trim()));
  if (
    indices.length === 0 ||
    indices.some((value) => !Number.isInteger(value)) ||
    new Set(indices).size !== indices.length
  ) {
    throw new Error("Cleanup audit indices must be unique integers.");
  }
  return indices;
}

/** @param {unknown} value @param {string} flag */
function requiredPathOption(value, flag) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Cleanup audit ${flag} is required.`);
  }
  return path.resolve(value);
}

/** @param {string} command @param {string[]} args */
function runChecked(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status ?? "null"}): ${command}`);
  }
}

function printHelp() {
  console.log(`Gemma cleanup audit (shadow-only)

Preflight one frozen page without inference (defaults to page 14):
  npm run qa:gemma-cleanup-audit -- preflight --index 14

Run the frozen ten-page experiment (starts local Gemma; explicit opt-in):
  npm run qa:gemma-cleanup-audit -- run --all --execute --output <new-dir>

Validate a completed sealed artifact against the frozen baseline:
  npm run qa:gemma-cleanup-audit -- validate --output <artifact-dir>

Options:
  --index N          exactly one frozen selection index (commas rejected)
  --indices A,B      ordered frozen subset/list
  --all              all 10 precommitted pages
  --cache DIR        exact-result cache directory (run only)
  --execute          required for live local Gemma inference
  --allow-partial    validate partial artifacts explicitly (validate only)
  --help             show this help; unknown/duplicate flags are rejected
`);
}

module.exports = {
  parseArguments,
  preflightCommand,
  resolveIndices,
  runCommand,
  validateCommand,
};
