// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("../runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */

const {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require("node:fs");
const { lstat, mkdir, readlink, rm, symlink } = require("node:fs/promises");
const path = require("node:path");
const {
  resolvePaddlexCacheAliasRoot,
  resolvePaddlexCacheHome,
  resolveRealPaddlexCacheHome,
} = require("../simple-page-ocr-runtime-config.cjs");
const {
  ensurePaddleOcrModelAssetsDownloaded,
} = require("../simple-page-model-assets.cjs");
const { emitRuntimeProgress } = require("./host-services.cjs");

const MANAGED_OCR_RUNTIME_FRAGMENTS = [
  "/manga-gemma-translator/ocr-runtime/",
  "/mgt-ocr-runtime/",
  "/.tmp/ocr-runtime/",
];

/** @param {RuntimeOptions} options @param {OcrRuntimeLayout} runtime @returns {Promise<OcrRuntimeLayout>} */
async function finalizePaddleOcrRuntime(options, runtime) {
  await ensurePaddleOcrModelAssetsDownloaded(options, runtime);
  return runtime;
}

/** @param {RuntimeOptions} options @param {string} runtimeDir @returns {Promise<OcrRuntimeLayout>} */
async function preparePaddlexCacheHome(options, runtimeDir) {
  const realPaddlexCacheHome = resolveRealPaddlexCacheHome(runtimeDir);
  const paddlexCacheHome = resolvePaddlexCacheHome(runtimeDir, options);
  await mkdir(realPaddlexCacheHome, { recursive: true });
  if (sameResolvedPath(paddlexCacheHome, realPaddlexCacheHome)) {
    return { paddlexCacheHome: realPaddlexCacheHome, realPaddlexCacheHome };
  }
  try {
    await ensurePaddlexCacheAlias(
      paddlexCacheHome,
      realPaddlexCacheHome,
      options,
    );
    emitPaddlexAliasReady(options, paddlexCacheHome);
    return { paddlexCacheHome, realPaddlexCacheHome };
  } catch (error) {
    emitPaddlexAliasFailure(options, error);
    return { paddlexCacheHome: realPaddlexCacheHome, realPaddlexCacheHome };
  }
}

/** @param {string} left @param {string} right @returns {boolean} */
function sameResolvedPath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

/** @param {string} aliasPath @param {string} targetPath @param {RuntimeOptions} options @returns {Promise<void>} */
async function ensurePaddlexCacheAlias(aliasPath, targetPath, options) {
  await mkdir(path.dirname(aliasPath), { recursive: true });
  await replaceStalePaddlexCacheAlias(aliasPath, targetPath, options);
  if (!existsSync(aliasPath)) {
    await symlink(targetPath, aliasPath, "junction");
  }
}

/** @param {RuntimeOptions} options @param {string} aliasPath */
function emitPaddlexAliasReady(options, aliasPath) {
  emitRuntimeProgress(
    options,
    "ocr_preparing",
    "Paddle OCR 캐시 경로 준비 중",
    "한글 경로 호환을 위해 안전한 캐시 별칭을 사용합니다.",
    {
      progressMode: "log-only",
      installLogLine: `Paddle OCR 캐시 별칭: ${aliasPath}`,
    },
  );
}

/** @param {RuntimeOptions} options @param {unknown} error */
function emitPaddlexAliasFailure(options, error) {
  emitRuntimeProgress(
    options,
    "ocr_preparing",
    "Paddle OCR 캐시 경로 별칭 실패",
    "원래 캐시 경로로 계속 진행합니다.",
    {
      progressMode: "log-only",
      installLogLine: `Paddle OCR 캐시 별칭 생성 실패: ${error instanceof Error ? error.message : String(error)}`,
    },
  );
}

/** @param {string} aliasPath @param {string} targetPath @param {RuntimeOptions} [options] @returns {Promise<void>} */
async function replaceStalePaddlexCacheAlias(
  aliasPath,
  targetPath,
  options = {},
) {
  const stats = await readOptionalAliasStats(aliasPath);
  if (!stats) {
    return;
  }
  if (
    stats.isSymbolicLink() &&
    (await aliasTargetsPath(aliasPath, targetPath))
  ) {
    return;
  }
  if (!isSafePaddlexCacheAliasPath(aliasPath, options)) {
    throw new Error(`Unsafe Paddle OCR cache alias path: ${aliasPath}`);
  }
  await rm(aliasPath, { recursive: true, force: true });
}

/** @param {string} aliasPath @returns {Promise<import("node:fs").Stats | null>} */
async function readOptionalAliasStats(aliasPath) {
  try {
    return await lstat(aliasPath);
  } catch (_error) {
    return null;
  }
}

/** @param {string} aliasPath @param {string} targetPath @returns {Promise<boolean>} */
async function aliasTargetsPath(aliasPath, targetPath) {
  try {
    const currentTarget = await readlink(aliasPath);
    return sameResolvedPath(
      path.resolve(path.dirname(aliasPath), currentTarget),
      targetPath,
    );
  } catch (_error) {
    return false;
  }
}

/** @param {string} aliasPath @param {RuntimeOptions} [options] @returns {boolean} */
function isSafePaddlexCacheAliasPath(aliasPath, options = {}) {
  const root = path.resolve(resolvePaddlexCacheAliasRoot(options));
  const relative = path.relative(root, path.resolve(aliasPath));
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

/** @param {string | null | undefined} pythonPath @param {string} packageDir @param {string | null} [runtimeDir] */
function ensureEmbeddedPythonPackagePath(
  pythonPath,
  packageDir,
  runtimeDir = null,
) {
  if (!pythonPath || path.basename(pythonPath).toLowerCase() !== "python.exe") {
    return;
  }
  const pythonDir = path.dirname(path.resolve(pythonPath));
  const pthName = findEmbeddedPythonPathFile(pythonDir);
  if (!pthName) {
    return;
  }
  updateEmbeddedPythonPathFile(
    path.join(pythonDir, pthName),
    pythonDir,
    packageDir,
    runtimeDir,
  );
}

/** @param {string} pythonDir @returns {string} */
function findEmbeddedPythonPathFile(pythonDir) {
  try {
    return (
      readdirSync(pythonDir).find((name) => /^python\d+._pth$/i.test(name)) ||
      ""
    );
  } catch (_error) {
    return "";
  }
}

/** @param {string} pthPath @param {string} pythonDir @param {string} packageDir @param {string | null} runtimeDir */
function updateEmbeddedPythonPathFile(
  pthPath,
  pythonDir,
  packageDir,
  runtimeDir,
) {
  try {
    const text = readFileSync(pthPath, "utf8");
    const nextText = buildEmbeddedPythonPathText(
      text,
      pythonDir,
      packageDir,
      runtimeDir,
    );
    if (nextText !== text) {
      writeFileSync(pthPath, nextText, "utf8");
    }
  } catch (_error) {
    // error-policy-allow: read-only packaged Python uses the explicit venv/target install path.
  }
}

/** @param {string} text @param {string} pythonDir @param {string} packageDir @param {string | null} runtimeDir @returns {string} */
function buildEmbeddedPythonPathText(text, pythonDir, packageDir, runtimeDir) {
  const normalizedRuntimeDir = runtimeDir ? path.resolve(runtimeDir) : "";
  const nextLines = text
    .split(/\r?\n/)
    .filter(
      (line) =>
        !isManagedOcrPackagePathLine(line, pythonDir, normalizedRuntimeDir),
    )
    .map((line) => (line.trim() === "#import site" ? "import site" : line));
  insertPackagePath(nextLines, path.resolve(packageDir));
  return `${nextLines.filter(isContentOrNotLastLine).join("\n")}\n`;
}

/** @param {string[]} lines @param {string} packageDir */
function insertPackagePath(lines, packageDir) {
  const importSiteIndex = lines.findIndex(
    (line) => line.trim() === "import site",
  );
  if (importSiteIndex === -1) {
    lines.push(packageDir, "import site");
  } else {
    lines.splice(importSiteIndex, 0, packageDir);
  }
}

/** @param {string} line @param {number} index @param {string[]} array @returns {boolean} */
function isContentOrNotLastLine(line, index, array) {
  return index < array.length - 1 || Boolean(line.trim());
}

/** @param {unknown} line @param {string} pythonDir @param {string} runtimeDir @returns {boolean} */
function isManagedOcrPackagePathLine(line, pythonDir, runtimeDir) {
  const raw = String(line ?? "").trim();
  if (!raw || raw.startsWith("#")) {
    return false;
  }
  const resolved = resolveOptionalPath(pythonDir, raw);
  if (!resolved) {
    return false;
  }
  return isManagedPackagePath(resolved, runtimeDir);
}

/** @param {string} baseDir @param {string} candidate @returns {string} */
function resolveOptionalPath(baseDir, candidate) {
  try {
    return path.resolve(baseDir, candidate);
  } catch (_error) {
    return "";
  }
}

/** @param {string} resolved @param {string} runtimeDir @returns {boolean} */
function isManagedPackagePath(resolved, runtimeDir) {
  const base = path.basename(resolved);
  const normalized = normalizePathForComparison(resolved);
  const normalizedRuntimeDir = runtimeDir
    ? normalizePathForComparison(path.resolve(runtimeDir))
    : "";
  if (base.startsWith("python-packages")) {
    return belongsToManagedRuntime(normalized, normalizedRuntimeDir);
  }
  return (
    base === "p" &&
    Boolean(normalizedRuntimeDir) &&
    normalized.startsWith(normalizedRuntimeDir)
  );
}

/** @param {string} value @returns {string} */
function normalizePathForComparison(value) {
  return value.replace(/\\/g, "/").toLowerCase();
}

/** @param {string} normalized @param {string} runtimeDir @returns {boolean} */
function belongsToManagedRuntime(normalized, runtimeDir) {
  if (runtimeDir && normalized.startsWith(runtimeDir)) {
    return true;
  }
  return MANAGED_OCR_RUNTIME_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}

module.exports = {
  ensureEmbeddedPythonPackagePath,
  finalizePaddleOcrRuntime,
  isManagedOcrPackagePathLine,
  preparePaddlexCacheHome,
};
