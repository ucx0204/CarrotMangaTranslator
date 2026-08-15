// @ts-check
const { existsSync, readdirSync } = require("node:fs");
const path = require("node:path");

const MAX_RUNTIME_LIBRARY_SCAN_DIRECTORIES = 4096;

/** @typedef {{ backend?: string; dir: string; id?: string; kind?: string; requiredFiles?: Array<string | string[]> }} LlamaRuntimeDescriptor */

function serverBinaryName() {
  return process.platform === "win32" ? "llama-server.exe" : "llama-server";
}

/** @param {string} runtimeDir */
function hasCudaRuntimeBackend(runtimeDir) {
  return hasAnyNamedFile(runtimeDir, [
    "ggml-cuda.dll",
    "ggml-cuda-cu12.dll",
    "ggml-cuda-cu13.dll",
  ]);
}

/** @param {string} runtimeDir @param {unknown} [backend] */
function hasLlamaRuntimeBackend(runtimeDir, backend = "cuda") {
  const names = backendLibraryNames(backend);
  return hasAnyNamedFile(runtimeDir, names);
}

/** @param {unknown} backend */
function backendLibraryNames(backend) {
  const normalized = String(backend || "cuda")
    .trim()
    .toLowerCase();
  if (normalized === "vulkan") {
    return ["ggml-vulkan.dll", "libggml-vulkan.so"];
  }
  if (normalized === "metal") {
    return [
      "libggml-metal.dylib",
      "libggml-metal.0.dylib",
      "ggml-metal.metal",
      "default.metallib",
    ];
  }
  if (normalized === "rocm" || normalized === "hip") {
    return [
      "ggml-hip.dll",
      "ggml-rocm.dll",
      "libggml-hip.so",
      "libggml-rocm.so",
    ];
  }
  return ["ggml-cuda.dll", "ggml-cuda-cu12.dll", "ggml-cuda-cu13.dll"];
}

/** @param {string} dir @param {string[]} names */
function hasAnyNamedFile(dir, names) {
  try {
    return names.some((fileName) => existsSync(path.join(dir, fileName)));
  } catch (_error) {
    return false;
  }
}

/** @param {string} dir */
function hasAnyRuntimeLibraryFile(dir) {
  const pending = [dir];
  let scannedDirectories = 0;
  try {
    while (pending.length > 0) {
      if (scannedDirectories >= MAX_RUNTIME_LIBRARY_SCAN_DIRECTORIES) {
        return false;
      }
      const current = pending.pop();
      if (!current) break;
      scannedDirectories += 1;
      if (scanRuntimeLibraryDirectory(current, pending)) return true;
    }
  } catch (_error) {
    return false;
  }
  return false;
}

/** @param {string} dir @param {string[]} pending */
function scanRuntimeLibraryDirectory(dir, pending) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:dat|co|hsaco)$/i.test(entry.name)) return true;
    // Runtime ZIP extraction owns this tree. Still avoid following links if an
    // installed directory is replaced or modified before validation.
    if (!entry.isSymbolicLink() && entry.isDirectory()) {
      pending.push(path.join(dir, entry.name));
    }
  }
  return false;
}

/** @param {string} runtimeDir */
function missingRocmRuntimeLibraryDirs(runtimeDir) {
  return [
    ["rocblas/library/*.dat|*.co|*.hsaco", "rocblas", "library"],
    ["hipblaslt/library/*.dat|*.co|*.hsaco", "hipblaslt", "library"],
  ]
    .filter(
      ([, ...parts]) =>
        !hasAnyRuntimeLibraryFile(path.join(runtimeDir, ...parts)),
    )
    .map(([label]) => label);
}

/** @param {string | null | undefined} runtimeDir @param {LlamaRuntimeDescriptor | null | undefined} runtime */
function hasRequiredLlamaRuntimeFiles(runtimeDir, runtime) {
  if (!runtimeDir || !runtime) return false;
  try {
    const requirements = runtime.requiredFiles || [serverBinaryName()];
    if (
      requirements.some(
        (requirement) => !requirementExists(runtimeDir, requirement),
      )
    ) {
      return false;
    }
    if (
      isRocmBackend(runtime.backend) &&
      missingRocmRuntimeLibraryDirs(runtimeDir).length > 0
    ) {
      return false;
    }
    return hasLlamaRuntimeBackend(runtimeDir, runtime.backend);
  } catch (_error) {
    return false;
  }
}

/** @param {string} runtimeDir @param {string | string[]} requirement */
function requirementExists(runtimeDir, requirement) {
  const candidates = Array.isArray(requirement) ? requirement : [requirement];
  return candidates.some((fileName) =>
    existsSync(path.join(runtimeDir, fileName)),
  );
}

/** @param {unknown} backend */
function isRocmBackend(backend) {
  return ["rocm", "hip"].includes(String(backend || "cuda").toLowerCase());
}

/** @param {string} runtimeDir @param {LlamaRuntimeDescriptor | null | undefined} runtime */
function missingRequiredLlamaRuntimeFiles(runtimeDir, runtime) {
  const requirements = runtime?.requiredFiles || [serverBinaryName()];
  const missing = requirements
    .filter((requirement) => !requirementExists(runtimeDir, requirement))
    .map((requirement) =>
      (Array.isArray(requirement) ? requirement : [requirement]).join(" | "),
    );
  if (!hasLlamaRuntimeBackend(runtimeDir, runtime?.backend)) {
    missing.push(backendLibraryNames(runtime?.backend).join(" | "));
  }
  if (isRocmBackend(runtime?.backend)) {
    missing.push(...missingRocmRuntimeLibraryDirs(runtimeDir));
  }
  return missing;
}

/** @param {string} serverPath @param {LlamaRuntimeDescriptor} runtime */
function isRuntimeCandidate(serverPath, runtime) {
  try {
    const runtimeDir = path.dirname(serverPath);
    return (
      path.basename(runtimeDir).toLowerCase() === runtime.dir.toLowerCase() &&
      hasRequiredLlamaRuntimeFiles(runtimeDir, runtime)
    );
  } catch (_error) {
    return false;
  }
}

module.exports = {
  hasCudaRuntimeBackend,
  hasLlamaRuntimeBackend,
  hasRequiredLlamaRuntimeFiles,
  isRuntimeCandidate,
  missingRequiredLlamaRuntimeFiles,
  serverBinaryName,
};
