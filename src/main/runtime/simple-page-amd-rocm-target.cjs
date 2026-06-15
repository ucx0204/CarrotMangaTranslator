const { execFileSync } = require("node:child_process");

const { runtimeOverrideEnv } = require("./simple-page-child-env.cjs");

const AMD_ROCM_TARGETS = new Set([
  "gfx908",
  "gfx90a",
  "gfx103X",
  "gfx110X",
  "gfx1150",
  "gfx1151",
  "gfx120X",
]);

function normalizeAmdRocmTarget(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, "");
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
    normalizeAmdRocmTarget(
      runtimeOverrideEnv("MANGA_TRANSLATOR_AMD_ROCM_TARGET", options),
    ) ||
    normalizeAmdRocmTarget(
      runtimeOverrideEnv("MANGA_TRANSLATOR_AMD_GFX_ARCH", options),
    ) ||
    normalizeAmdRocmTarget(options.llamaRocmTarget) ||
    normalizeAmdRocmTarget(options.amdRocmTarget) ||
    normalizeAmdRocmTarget(options.rocmTarget) ||
    normalizeAmdRocmTarget(options.rocmArch) ||
    (options.disableHostRocmTargetDetection ? null : detectHostAmdRocmTarget())
  );
}

function detectHostAmdRocmTarget() {
  return detectWindowsAmdRocmTarget() || detectRocmSmiTarget() || null;
}

function detectWindowsAmdRocmTarget() {
  if (process.platform !== "win32") {
    return null;
  }
  try {
    const stdout = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        [
          "$pattern = 'AMD|Radeon|ATI|Advanced Micro Devices|VEN_1002|V710';",
          "$video = Get-CimInstance Win32_VideoController | Where-Object { (($_.Name, $_.AdapterCompatibility, $_.VideoProcessor, $_.PNPDeviceID) -join ' ') -match $pattern } | ForEach-Object { ($_.Name, $_.AdapterCompatibility, $_.VideoProcessor, $_.PNPDeviceID) -join ' ' };",
          "$pnp = Get-CimInstance Win32_PnPEntity | Where-Object { (($_.Name, $_.Manufacturer, $_.PNPClass, $_.DeviceID) -join ' ') -match $pattern } | ForEach-Object { ($_.Name, $_.Manufacturer, $_.PNPClass, $_.DeviceID) -join ' ' };",
          "$video; $pnp",
        ].join(" "),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    );
    return inferAmdRocmTargetFromText(stdout);
  } catch {
    return null;
  }
}

function detectRocmSmiTarget() {
  try {
    const stdout = execFileSync(
      "rocm-smi",
      ["--showproductname", "--showmeminfo", "vram", "--csv"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      },
    );
    return inferAmdRocmTargetFromText(stdout);
  } catch {
    return null;
  }
}

function inferAmdRocmTargetFromText(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[™®]/g, " ");
  if (!normalized.trim()) {
    return null;
  }
  const explicitArch = normalized.match(
    /\bgfx[0-9a-f]+(?:[:_a-z0-9.-]*)?\b/i,
  )?.[0];
  const explicitTarget = normalizeAmdRocmTarget(explicitArch);
  if (explicitTarget) {
    return explicitTarget;
  }
  if (/\bmi\s*100\b|\binstinct\s+mi100\b/.test(normalized)) {
    return "gfx908";
  }
  if (
    /\bmi\s*(200|210|250)\b|\binstinct\s+mi(200|210|250)\b/.test(normalized)
  ) {
    return "gfx90a";
  }
  if (
    /\b(?:amd\s+)?(?:radeon\s+)?(?:ai\s+)?pro\s+r\s*9700\b/.test(normalized) ||
    /\b(rx\s*)?90(60|70)\b|\b(rx\s*)?90(60|70)\s*(xt|gre)\b/.test(normalized)
  ) {
    return "gfx120X";
  }
  if (
    /\b(?:amd\s+)?(?:radeon\s+)?(?:pro\s+)?v\s*710(?:\s*mxgpu)?(?:[-\s]\d+q)?\b/.test(
      normalized,
    ) ||
    /\bven_1002&dev_746[01]\b/.test(normalized) ||
    /\bven_1002&dev_7480\b/.test(normalized) ||
    /\b(rx\s*)?7(600|650|700|800|900)\b|\b(rx\s*)?7(600|650|700|800|900)\s*(xt|xtx|gre)\b/.test(
      normalized,
    ) ||
    /\b(?:radeon\s+)?(?:pro\s*)?w7(500|600|700|800|900)\b/.test(normalized) ||
    /\bradeon\s+(740m|760m|780m)\b/.test(normalized)
  ) {
    return "gfx110X";
  }
  if (
    /\b(?:radeon\s+)?pro\s+(v\s*620|w\s*(6600|6800))\b/.test(normalized) ||
    /\b(rx\s*)?6(400|500|600|650|700|750|800|900|950)\b|\b(rx\s*)?6(400|500|600|650|700|750|800|900|950)\s*(xt|m|s)\b/.test(
      normalized,
    )
  ) {
    return "gfx103X";
  }
  if (
    /\bryzen\s+ai\s+max\b|\bstrix\s+halo\b|\bradeon\s+80(50|60)s\b/.test(
      normalized,
    )
  ) {
    return "gfx1151";
  }
  if (
    /\bryzen\s+ai\s+9\s+(hx\s*37(0|5)|365)\b|\bradeon\s+(880m|890m)\b/.test(
      normalized,
    )
  ) {
    return "gfx1150";
  }
  return null;
}

module.exports = {
  AMD_ROCM_TARGETS,
  inferAmdRocmTargetFromText,
  normalizeAmdRocmTarget,
  resolveAmdRocmTargetFromOptions,
};
