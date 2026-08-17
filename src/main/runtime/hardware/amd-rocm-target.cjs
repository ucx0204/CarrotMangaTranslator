// @ts-check
const { execFileSync } = require("node:child_process");

const { runtimeOverrideEnv } = require("../simple-page-child-env.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */

const AMD_ROCM_TARGETS = new Set([
  "gfx908",
  "gfx90a",
  "gfx103X",
  "gfx110X",
  "gfx1150",
  "gfx1151",
  "gfx120X",
]);

/** @type {Array<{ target: string; patterns: RegExp[] }>} */
const AMD_ROCM_TEXT_MATCHERS = [
  {
    target: "gfx908",
    patterns: [/\bmi\s*100\b|\binstinct\s+mi100\b/],
  },
  {
    target: "gfx90a",
    patterns: [/\bmi\s*(200|210|250)\b|\binstinct\s+mi(200|210|250)\b/],
  },
  {
    target: "gfx120X",
    patterns: [
      /\b(?:amd\s+)?(?:radeon\s+)?(?:ai\s+)?pro\s+r\s*9700\b/,
      /\b(?:amd\s+)?(?:radeon\s+)?(?:rx\s*)?9\d{3}(?:\s*(?:xtx?|gre|m(?:\s*xt)?|s))?\b/,
    ],
  },
  {
    target: "gfx110X",
    patterns: [
      /\b(?:amd\s+)?(?:radeon\s+)?(?:pro\s+)?v\s*710(?:\s*mxgpu)?(?:[-\s]\d+q)?\b/,
      /\bven_1002&dev_746[01]\b/,
      /\bven_1002&dev_7480\b/,
      /\b(?:amd\s+)?(?:radeon\s+)?(?:rx\s*)?7\d{3}(?:\s*(?:xtx?|gre|m(?:\s*xt)?|s))?\b/,
      /\b(?:radeon\s+)?(?:pro\s*)?w7(500|600|700|800|900)\b/,
      /\bradeon\s+(740m|760m|780m)\b/,
    ],
  },
  {
    target: "gfx103X",
    patterns: [
      /\b(?:radeon\s+)?pro\s+(v\s*620|w\s*(6600|6800))\b/,
      /\b(?:amd\s+)?(?:radeon\s+)?(?:rx\s*)?6\d{3}(?:\s*(?:xtx?|gre|m(?:\s*xt)?|s))?\b/,
    ],
  },
  {
    target: "gfx1151",
    patterns: [/\bryzen\s+ai\s+max\b|\bstrix\s+halo\b|\bradeon\s+80(50|60)s\b/],
  },
  {
    target: "gfx1150",
    patterns: [
      /\bryzen\s+ai\s+9\s+(hx\s*37(0|5)|365)\b|\bradeon\s+(880m|890m)\b/,
    ],
  },
];

/** @param {unknown} value @returns {string | null} */
function normalizeAmdRocmTarget(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, "");
  if (/^gfx103[0-9a-fx]*$/.test(normalized)) {
    return "gfx103X";
  }
  if (/^gfx110[0-9a-fx]*$/.test(normalized)) {
    return "gfx110X";
  }
  if (/^gfx120[0-9a-fx]*$/.test(normalized)) {
    return "gfx120X";
  }
  return AMD_ROCM_TARGETS.has(normalized) ? normalized : null;
}

/** @param {RuntimeOptions} [options] @returns {string | null} */
function resolveAmdRocmTargetFromOptions(options = {}) {
  const candidates = [
    runtimeOverrideEnv("MANGA_TRANSLATOR_AMD_ROCM_TARGET", options),
    runtimeOverrideEnv("MANGA_TRANSLATOR_AMD_GFX_ARCH", options),
    options.llamaRocmTarget,
    options.amdRocmTarget,
    options.rocmTarget,
    options.rocmArch,
  ];
  for (const candidate of candidates) {
    const target = normalizeAmdRocmTarget(candidate);
    if (target) {
      return target;
    }
  }
  return options.disableHostRocmTargetDetection
    ? null
    : detectHostAmdRocmTarget();
}

function detectHostAmdRocmTarget() {
  return detectWindowsAmdRocmTarget() || detectRocmSmiTarget() || null;
}

function detectWindowsAmdRocmTarget() {
  if (process.platform !== "win32") {
    return null;
  }
  return runTargetProbe("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      "$pattern = 'AMD|Radeon|ATI|Advanced Micro Devices|VEN_1002|V710';",
      "$displayClass = '{4d36e968-e325-11ce-bfc1-08002be10318}';",
      "$isActive = { param($item) $code = $item.ConfigManagerErrorCode; $present = $item.Present; ($null -eq $code -or [int]$code -eq 0) -and ($null -eq $present -or [bool]$present) };",
      "$video = Get-CimInstance Win32_VideoController | Where-Object { (($_.Name, $_.AdapterCompatibility, $_.VideoProcessor, $_.PNPDeviceID) -join ' ') -match $pattern -and (& $isActive $_) } | ForEach-Object { ($_.Name, $_.AdapterCompatibility, $_.VideoProcessor, $_.PNPDeviceID) -join ' ' };",
      "$pnp = Get-CimInstance Win32_PnPEntity | Where-Object { ($_.PNPClass -eq 'Display' -or $_.ClassGuid -eq $displayClass) -and (($_.Name, $_.Manufacturer, $_.PNPClass, $_.DeviceID) -join ' ') -match $pattern -and (& $isActive $_) } | ForEach-Object { ($_.Name, $_.Manufacturer, $_.PNPClass, $_.DeviceID) -join ' ' };",
      "$video; $pnp",
    ].join(" "),
  ]);
}

function detectRocmSmiTarget() {
  return runTargetProbe("rocm-smi", [
    "--showproductname",
    "--showmeminfo",
    "vram",
    "--csv",
  ]);
}

/** @param {string} command @param {string[]} args */
function runTargetProbe(command, args) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    return selectAmdRocmTargetFromProbeText(stdout);
  } catch (_error) {
    return null;
  }
}

/** @param {unknown} value @returns {string | null} */
function selectAmdRocmTargetFromProbeText(value) {
  const candidates = String(value ?? "")
    .split(/\r?\n/)
    .map((line, index) => ({
      index,
      priority: resolveAmdAdapterClassPriority(line),
      target: inferAmdRocmTargetFromText(line),
    }))
    .filter((candidate) => candidate.target)
    .sort(
      (left, right) =>
        right.priority - left.priority || left.index - right.index,
    );
  return candidates[0]?.target ?? inferAmdRocmTargetFromText(value);
}

/** @param {unknown} value @returns {number} */
function resolveAmdAdapterClassPriority(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[™®]/g, " ");
  if (
    /\brx\s*\d{3,4}(?:\s*(?:xtx?|gre|m(?:\s*xt)?|s))?\b|\bradeon\s+pro\s+[wv]\s*\d+\b|\bpro\s+v\s*\d+\b|\binstinct\b|\bmi\s*\d+\b/.test(
      normalized,
    )
  ) {
    return 2;
  }
  if (
    /\bryzen\b|\bradeon\s+(?:\d{3,4}[ms])\b|\bradeon(?:\(tm\))?\s+graphics\b/.test(
      normalized,
    )
  ) {
    return 0;
  }
  return 1;
}

/** @param {unknown} value @returns {string | null} */
function inferAmdRocmTargetFromText(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[™®]/g, " ");
  if (!normalized.trim()) {
    return null;
  }
  const explicit = normalizeAmdRocmTarget(
    normalized.match(/\bgfx[0-9a-f]+(?:[:_a-z0-9.-]*)?\b/i)?.[0],
  );
  if (explicit) {
    return explicit;
  }
  return matchKnownAmdTarget(normalized);
}

/** @param {string} normalized @returns {string | null} */
function matchKnownAmdTarget(normalized) {
  for (const matcher of AMD_ROCM_TEXT_MATCHERS) {
    if (matcher.patterns.some((pattern) => pattern.test(normalized))) {
      return matcher.target;
    }
  }
  return null;
}

module.exports = {
  AMD_ROCM_TARGETS,
  inferAmdRocmTargetFromText,
  normalizeAmdRocmTarget,
  resolveAmdRocmTargetFromOptions,
  selectAmdRocmTargetFromProbeText,
};
