const { runtimeOverrideEnv } = require("./simple-page-child-env.cjs");

const AMD_ROCM_TARGETS = new Set(["gfx908", "gfx90a", "gfx103X", "gfx110X", "gfx1150", "gfx1151", "gfx120X"]);

function normalizeAmdRocmTarget(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[-_\s]/g, "");
  if (!normalized) {
    return null;
  }
  if (normalized === "gfx908") {
    return "gfx908";
  }
  if (normalized === "gfx90a") {
    return "gfx90a";
  }
  if (/^gfx103[0-9a-fx]*$/.test(normalized)) {
    return "gfx103X";
  }
  if (/^gfx110[0-9a-fx]*$/.test(normalized)) {
    return "gfx110X";
  }
  if (normalized === "gfx1150") {
    return "gfx1150";
  }
  if (normalized === "gfx1151") {
    return "gfx1151";
  }
  if (/^gfx120[0-9a-fx]*$/.test(normalized)) {
    return "gfx120X";
  }
  return null;
}

function resolveAmdRocmTargetFromOptions(options = {}) {
  return (
    normalizeAmdRocmTarget(runtimeOverrideEnv("MANGA_TRANSLATOR_AMD_ROCM_TARGET", options)) ||
    normalizeAmdRocmTarget(runtimeOverrideEnv("MANGA_TRANSLATOR_AMD_GFX_ARCH", options)) ||
    normalizeAmdRocmTarget(options.llamaRocmTarget) ||
    normalizeAmdRocmTarget(options.amdRocmTarget) ||
    normalizeAmdRocmTarget(options.rocmTarget) ||
    normalizeAmdRocmTarget(options.rocmArch)
  );
}

module.exports = {
  AMD_ROCM_TARGETS,
  normalizeAmdRocmTarget,
  resolveAmdRocmTargetFromOptions
};
