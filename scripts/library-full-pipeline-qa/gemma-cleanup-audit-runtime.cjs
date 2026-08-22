// @ts-check

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  AUDIT_CONTRACT_VERSION,
  sealRecord,
  sha256Canonical,
} = require("./gemma-cleanup-audit-contract.cjs");

/**
 * Preflight binds the declared frozen model but is intentionally impossible to
 * pass to the live executor. Runtime/model bytes are sealed only in Electron
 * immediately before a live shadow request.
 * @param {Record<string,any>} model
 */
function buildPreflightRuntimeBinding(model) {
  return sealRecord({
    contractVersion: AUDIT_CONTRACT_VERSION,
    bindingKind: "preflight-declaration",
    executionAllowed: false,
    shadowOnly: true,
    productionMutationAllowed: false,
    model: structuredClone(model),
    unresolvedFields: [
      "modelSha256",
      "mmprojSha256",
      "serverRuntimeSha256",
      "chatTemplateSha256",
      "launchArgumentsSha256",
    ],
  });
}

/**
 * @param {{
 *   options:Record<string,any>;
 *   expectedModel:Record<string,any>;
 *   launchedServer:Record<string,any>;
 *   inspectModelLaunch:(options:Record<string,any>)=>Record<string,any>;
 *   resolveRequestModelName:(options:Record<string,any>)=>string;
 *   verifyChatTemplate:()=>string;
 *   templateProvenance:Record<string,unknown>;
 * }} input
 */
async function buildLiveRuntimeBinding(input) {
  assertExpectedModel(input.options, input.expectedModel);
  const child = input.launchedServer?.child;
  if (
    input.launchedServer?.startedByScript !== true ||
    !child ||
    typeof child.spawnfile !== "string" ||
    !Array.isArray(child.spawnargs)
  ) {
    throw new Error(
      "Cleanup audit requires the exact newly launched local Gemma process.",
    );
  }
  const target = input.inspectModelLaunch(input.options);
  const modelPath = requiredPath(target.modelPath, "model");
  const mmprojPath = requiredPath(target.mmprojPath, "mmproj");
  const serverPath = requiredPath(child.spawnfile, "launched llama-server");
  const templatePath = requiredPath(
    input.verifyChatTemplate(),
    "Gemma chat template",
  );
  const [model, mmproj, serverRuntime, chatTemplate] = await Promise.all([
    hashFile(modelPath),
    hashFile(mmprojPath),
    hashFile(serverPath),
    hashFile(templatePath),
  ]);
  const spawnArguments = child.spawnargs.map(String);
  const launchArguments = stripSpawnExecutable(spawnArguments, serverPath);
  assertCacheDisabled(launchArguments);
  assertExactLaunchedAsset(
    launchArguments,
    ["-m", "--model"],
    modelPath,
    "model",
  );
  assertExactLaunchedAsset(launchArguments, ["--mmproj"], mmprojPath, "mmproj");
  assertPinnedRuntimeAssets(
    { model, mmproj, chatTemplate },
    input.expectedModel,
    input.templateProvenance,
  );
  const modelName = input.resolveRequestModelName(input.options);
  if (!modelName) throw new Error("Cleanup audit request model name is empty.");
  const binding = sealRecord({
    contractVersion: AUDIT_CONTRACT_VERSION,
    bindingKind: "live-local-gemma-runtime",
    executionAllowed: true,
    shadowOnly: true,
    productionMutationAllowed: false,
    modelProvider: "gemma",
    modelName,
    configuredModel: structuredClone(input.expectedModel),
    launchMode: target.launchMode,
    model,
    mmproj,
    serverRuntime,
    chatTemplate: {
      ...chatTemplate,
      ...structuredClone(input.templateProvenance),
    },
    launchArguments,
    spawnArguments,
    spawnArgumentsSha256: sha256Canonical(spawnArguments),
    launchArgumentsSha256: sha256Canonical(launchArguments),
    generationRuntime: {
      ctx: input.options.ctx,
      imageMinTokens: input.options.imageMinTokens,
      imageMaxTokens: input.options.imageMaxTokens,
      gemmaVramMode: input.options.gemmaVramMode,
      llamaRuntimeProfile: input.options.llamaRuntimeProfile,
      includeEnhancedVariant: false,
      useDraft: false,
      cachePrompt: false,
      parallelSlots: 1,
    },
  });
  return { binding, modelName };
}

/** @param {Record<string,any>} options @param {Record<string,any>} expected */
function assertExpectedModel(options, expected) {
  if (
    expected.provider !== "gemma" ||
    expected.source !== "huggingface" ||
    options.modelProvider !== "gemma" ||
    options.modelSource !== "huggingface" ||
    options.modelRepo !== expected.repo ||
    options.modelFile !== expected.file ||
    options.mmprojRepo !== expected.mmproj?.repo ||
    options.mmprojFile !== expected.mmproj?.file ||
    options.useDraft !== false ||
    options.includeEnhancedVariant !== false ||
    options.reuseServer !== false ||
    Number(options.cacheReuse) !== 0 ||
    Number(options.cacheIdleSlots) !== 0
  ) {
    throw new Error(
      "Cleanup audit live model/options differ from the frozen contract.",
    );
  }
}

/** @param {string[]} launchArguments */
function assertCacheDisabled(launchArguments) {
  const noCache = launchArguments.filter(
    (value) => value === "--no-cache-prompt",
  );
  const conflictingCache = launchArguments.filter(
    (value) =>
      value === "--cache-prompt" || value.startsWith("--cache-prompt="),
  );
  const parallel = collectFlagValues(launchArguments, ["-np", "--parallel"]);
  if (
    noCache.length !== 1 ||
    conflictingCache.length !== 0 ||
    parallel.length !== 1 ||
    parallel[0] !== "1"
  ) {
    throw new Error(
      "Cleanup audit requires prompt cache disabled and exactly one server slot.",
    );
  }
}

/** @param {string[]} args @param {string[]} flags */
function collectFlagValues(args, flags) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (flags.includes(args[index])) {
      values.push(args[index + 1] ?? "");
    }
    if (flags.some((flag) => args[index].startsWith(`${flag}=`))) {
      values.push(args[index].split("=", 2)[1] ?? "");
    }
  }
  return values;
}

/** @param {string[]} spawnArguments @param {string} serverPath */
function stripSpawnExecutable(spawnArguments, serverPath) {
  if (spawnArguments.length === 0) {
    throw new Error("Cleanup audit launched process has no spawn arguments.");
  }
  const first = path.resolve(spawnArguments[0]);
  return first === path.resolve(serverPath)
    ? spawnArguments.slice(1)
    : [...spawnArguments];
}

/** @param {string[]} args @param {string[]} flags @param {string} expectedPath @param {string} label */
function assertExactLaunchedAsset(args, flags, expectedPath, label) {
  const values = collectFlagValues(args, flags);
  if (
    values.length !== 1 ||
    path.resolve(values[0]) !== path.resolve(expectedPath)
  ) {
    throw new Error(`Cleanup audit launched ${label} path is not exact.`);
  }
}

/** @param {{model:Record<string,any>;mmproj:Record<string,any>;chatTemplate:Record<string,any>}} assets @param {Record<string,any>} expected @param {Record<string,unknown>} template */
function assertPinnedRuntimeAssets(assets, expected, template) {
  if (
    assets.model.sha256 !== expected.expectedSha256 ||
    assets.mmproj.sha256 !== expected.mmproj?.expectedSha256 ||
    assets.chatTemplate.sha256 !== template.expectedSha256 ||
    assets.chatTemplate.bytes !== template.expectedBytes ||
    template.revision !== expected.chatTemplate?.revision ||
    template.expectedSha256 !== expected.chatTemplate?.expectedSha256 ||
    template.expectedBytes !== expected.chatTemplate?.expectedBytes
  ) {
    throw new Error("Cleanup audit launched runtime differs from frozen pins.");
  }
}

/**
 * Rehash every exact launched file recorded by a live binding. Used by the
 * offline validator; it never prepares/downloads a model.
 * @param {Record<string,any>} binding
 * @param {Record<string,any>} manifest
 */
async function validateLiveRuntimeBindingFiles(binding, manifest) {
  if (
    binding.bindingKind !== "live-local-gemma-runtime" ||
    binding.executionAllowed !== true ||
    binding.shadowOnly !== true ||
    binding.productionMutationAllowed !== false
  ) {
    throw new Error("Cleanup audit live runtime safety binding is invalid.");
  }
  const seal = require("./gemma-cleanup-audit-contract.cjs").verifySealedRecord(
    binding,
  );
  if (seal.length > 0) {
    throw new Error(`Cleanup audit runtime seal invalid: ${seal.join(", ")}`);
  }
  assertCacheDisabled(binding.launchArguments);
  if (
    binding.launchArgumentsSha256 !==
      sha256Canonical(binding.launchArguments) ||
    binding.spawnArgumentsSha256 !== sha256Canonical(binding.spawnArguments)
  ) {
    throw new Error("Cleanup audit runtime launch argument binding changed.");
  }
  const replayedLaunchArguments = stripSpawnExecutable(
    binding.spawnArguments,
    binding.serverRuntime?.path,
  );
  if (
    sha256Canonical(replayedLaunchArguments) !==
    sha256Canonical(binding.launchArguments)
  ) {
    throw new Error("Cleanup audit runtime spawn argument replay changed.");
  }
  assertExactLaunchedAsset(
    binding.launchArguments,
    ["-m", "--model"],
    binding.model?.path,
    "model",
  );
  assertExactLaunchedAsset(
    binding.launchArguments,
    ["--mmproj"],
    binding.mmproj?.path,
    "mmproj",
  );
  assertPinnedRuntimeAssets(
    {
      model: binding.model,
      mmproj: binding.mmproj,
      chatTemplate: binding.chatTemplate,
    },
    manifest.model,
    manifest.model.chatTemplate,
  );
  for (const key of ["model", "mmproj", "serverRuntime", "chatTemplate"]) {
    const expected = binding[key];
    const actual = await hashFile(requiredPath(expected?.path, key));
    if (
      actual.sha256 !== expected.sha256 ||
      actual.bytes !== expected.bytes ||
      path.resolve(actual.path) !== path.resolve(expected.path)
    ) {
      throw new Error(`Cleanup audit runtime file changed: ${key}`);
    }
  }
}

/** @param {unknown} value @param {string} label */
function requiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Cleanup audit ${label} path is unavailable.`);
  }
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Cleanup audit ${label} file is unavailable: ${resolved}`);
  }
  return resolved;
}

/** @param {string} filePath */
async function hashFile(filePath) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(
      `Cleanup audit runtime asset is not a nonempty file: ${filePath}`,
    );
  }
  const digest = nodeCrypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return {
    path: path.resolve(filePath),
    bytes: stat.size,
    sha256: digest.digest("hex"),
  };
}

/** @param {string} root @param {string} runId */
function buildAuditRunPaths(root, runId) {
  if (!/^[a-f0-9-]{16,64}$/iu.test(runId)) {
    throw new Error("Cleanup audit run ID is invalid.");
  }
  const runRoot = path.join(
    path.resolve(root),
    ".tmp",
    "gemma-cleanup-audit",
    "runs",
    runId,
  );
  return {
    tempRoot: path.join(path.resolve(root), ".tmp", "gemma-cleanup-audit"),
    runRoot,
    userData: path.join(runRoot, "electron-user-data"),
    serverLog: path.join(runRoot, "server.log"),
    lockPath: path.join(
      path.resolve(root),
      ".tmp",
      "gemma-cleanup-audit",
      "locks",
      "live.lock",
    ),
  };
}

/** @param {{root:string;runId:string;outputRoot:string;writeGuard:()=>Promise<void>}} options */
async function acquireAuditRunLock(options) {
  if (typeof options.writeGuard !== "function") {
    throw new Error("Cleanup audit live lock requires a runtime write guard.");
  }
  const paths = buildAuditRunPaths(options.root, options.runId);
  await options.writeGuard();
  await fsp.mkdir(path.dirname(paths.lockPath), { recursive: true });
  await options.writeGuard();
  const token = nodeCrypto.randomUUID();
  const contents = JSON.stringify({
    contractVersion: AUDIT_CONTRACT_VERSION,
    token,
    pid: process.pid,
    runId: options.runId,
    outputRoot: path.resolve(options.outputRoot),
  });
  let handle;
  try {
    await options.writeGuard();
    handle = await fsp.open(paths.lockPath, "wx");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await options.writeGuard();
  } catch (error) {
    await handle?.close().catch((_closeError) => {
      // error-policy-allow: preserve the original lock acquisition failure.
    });
    if (
      error &&
      typeof error === "object" &&
      Reflect.get(error, "code") === "EEXIST"
    ) {
      throw new Error(
        `Another cleanup audit owns the live runtime lock: ${paths.lockPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  let released = false;
  return {
    ...paths,
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      const current = await fsp.readFile(paths.lockPath, "utf8");
      if (current !== contents) {
        throw new Error("Cleanup audit live lock ownership changed.");
      }
      await options.writeGuard();
      await fsp.unlink(paths.lockPath);
      await options.writeGuard();
    },
  };
}

module.exports = {
  acquireAuditRunLock,
  assertCacheDisabled,
  buildLiveRuntimeBinding,
  buildPreflightRuntimeBinding,
  buildAuditRunPaths,
  hashFile,
  validateLiveRuntimeBindingFiles,
};
