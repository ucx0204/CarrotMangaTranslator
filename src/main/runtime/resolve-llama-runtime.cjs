const { existsSync, readdirSync } = require("node:fs");
const { dirname, join } = require("node:path");

function binaryName() {
  return process.platform === "win32" ? "llama-server.exe" : "llama-server";
}

function bundledServerCandidates(toolsDir) {
  const serverBinary = binaryName();
  const knownRuntimeDirs = [
    "beellama-v0.2.0-cuda13.1",
    "beellama-v0.2.0-cuda12.4",
    "lemonade-llama-b1291-rocm-gfx120X",
    "lemonade-llama-b1291-rocm-gfx1151",
    "lemonade-llama-b1291-rocm-gfx1150",
    "lemonade-llama-b1291-rocm-gfx110X",
    "lemonade-llama-b1291-rocm-gfx103X",
    "lemonade-llama-b1291-rocm-gfx90a",
    "lemonade-llama-b1291-rocm-gfx908",
    "llama-b9547-vulkan",
    "llama-b9547-cuda13.3",
    "llama-b9547-cuda12.4",
    "llama-b9360-cuda13.1",
    "llama-b8833-cuda12.4",
    "llama-b8808-cuda12"
  ];
  const candidates = [
    ...knownRuntimeDirs.map((runtimeDir) => join(toolsDir, runtimeDir, serverBinary)),
    join(toolsDir, serverBinary)
  ];

  for (const runtimeDir of listRuntimeDirs(toolsDir)) {
    candidates.push(join(toolsDir, runtimeDir, serverBinary));
  }

  return uniquePaths(candidates);
}

function hasCudaBackend(serverPath) {
  const runtimeDir = dirname(serverPath);
  return [
    "ggml-cuda.dll",
    "ggml-cuda-cu12.dll",
    "ggml-cuda-cu13.dll"
  ].some((fileName) => existsSync(join(runtimeDir, fileName)));
}

function hasRocmBackend(serverPath) {
  const runtimeDir = dirname(serverPath);
  return [
    "ggml-hip.dll",
    "ggml-rocm.dll",
    "libggml-hip.so",
    "libggml-rocm.so"
  ].some((fileName) => existsSync(join(runtimeDir, fileName)));
}

function hasVulkanBackend(serverPath) {
  const runtimeDir = dirname(serverPath);
  return [
    "ggml-vulkan.dll",
    "libggml-vulkan.so"
  ].some((fileName) => existsSync(join(runtimeDir, fileName)));
}

function hasGpuBackend(serverPath) {
  return hasCudaBackend(serverPath) || hasRocmBackend(serverPath) || hasVulkanBackend(serverPath);
}

function resolveBundledServerPath(toolsDir) {
  const candidates = bundledServerCandidates(toolsDir).filter((candidate) => existsSync(candidate));
  return candidates.find((candidate) => hasGpuBackend(candidate))
    ?? candidates[0]
    ?? bundledServerCandidates(toolsDir)[0];
}

function listRuntimeDirs(toolsDir) {
  try {
    return readdirSync(toolsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const candidate of paths) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

module.exports = {
  bundledServerCandidates,
  hasCudaBackend,
  hasGpuBackend,
  hasRocmBackend,
  hasVulkanBackend,
  resolveBundledServerPath
};
