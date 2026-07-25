import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isPathInside } from "../../runtimeSupport/fileProbe";

export function ensureEmbeddedPythonPackagePath(
  pythonPath: string,
  packageDir: string,
): void {
  if (basename(pythonPath).toLowerCase() !== "python.exe") {
    return;
  }
  const pythonDir = dirname(resolve(pythonPath));
  let pthName: string | undefined;
  try {
    pthName = readdirSync(pythonDir).find((name) =>
      /^python\d+._pth$/i.test(name),
    );
  } catch (_error) {
    return;
  }
  if (!pthName) {
    return;
  }
  updateEmbeddedPythonPackagePath(pythonDir, pthName, packageDir);
}

export function sanitizeStandaloneEmbeddedPythonPathFile(
  outputDir: string,
): void {
  let pthName: string | undefined;
  try {
    pthName = readdirSync(outputDir).find((name) =>
      /^python\d+._pth$/i.test(name),
    );
  } catch (_error) {
    return;
  }
  if (!pthName) {
    return;
  }
  sanitizeEmbeddedPythonPathFile(outputDir, pthName);
}

function updateEmbeddedPythonPackagePath(
  pythonDir: string,
  pthName: string,
  packageDir: string,
): void {
  const pthPath = join(pythonDir, pthName);
  try {
    const normalizedPackageDir = resolve(packageDir);
    const text = readFileSync(pthPath, "utf8");
    const nextLines = buildPackagePathLines(
      text,
      pythonDir,
      normalizedPackageDir,
    );
    const nextText = `${nextLines.filter(hasUsefulTrailingLine).join("\n")}\n`;
    if (nextText !== text) {
      writeFileSync(pthPath, nextText, "utf8");
    }
  } catch (_error) {
    // error-policy-allow: PYTHONPATH remains the supported fallback for non-isolated builds.
  }
}

function buildPackagePathLines(
  text: string,
  pythonDir: string,
  normalizedPackageDir: string,
): string[] {
  const nextLines = text
    .split(/\r?\n/)
    .filter(
      (line) =>
        !isManagedFluxPackagePathLine(line, pythonDir, normalizedPackageDir),
    )
    .map((line) => (line.trim() === "#import site" ? "import site" : line));
  const importSiteIndex = nextLines.findIndex(
    (line) => line.trim() === "import site",
  );
  if (importSiteIndex === -1) {
    nextLines.push(normalizedPackageDir, "import site");
  } else {
    nextLines.splice(importSiteIndex, 0, normalizedPackageDir);
  }
  return nextLines;
}

function sanitizeEmbeddedPythonPathFile(
  outputDir: string,
  pthName: string,
): void {
  const pthPath = join(outputDir, pthName);
  try {
    const text = readFileSync(pthPath, "utf8");
    const nextText = buildStandaloneEmbeddedPythonPathText(
      outputDir,
      pthName,
      sanitizeEmbeddedPythonPathLines(text, outputDir),
    );
    if (nextText !== text) {
      writeFileSync(pthPath, nextText, "utf8");
    }
  } catch (_error) {
    // error-policy-allow: the required runtime import check reports the actionable failure later.
  }
}

function sanitizeEmbeddedPythonPathLines(
  text: string,
  outputDir: string,
): string[] {
  const sanitized: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (shouldDropEmbeddedPythonPathLine(trimmed, outputDir, sanitized)) {
      continue;
    }
    sanitized.push(line);
  }
  return sanitized;
}

function shouldDropEmbeddedPythonPathLine(
  trimmed: string,
  outputDir: string,
  sanitized: string[],
): boolean {
  return (
    trimmed === "#import site" ||
    trimmed === "import site" ||
    isManagedFluxPackagePathLine(trimmed, outputDir) ||
    (!trimmed && sanitized[sanitized.length - 1] === "")
  );
}

function buildStandaloneEmbeddedPythonPathText(
  outputDir: string,
  pthName: string,
  lines: string[],
): string {
  const pthEntries = buildStandaloneEmbeddedPythonPathEntries(
    outputDir,
    pthName,
    lines,
  );
  return `${pthEntries.join("\n")}\n`;
}

function buildStandaloneEmbeddedPythonPathEntries(
  outputDir: string,
  pthName: string,
  lines: string[],
): string[] {
  const pthEntries: string[] = [];
  const stdlibZipName = pthName.replace(/._pth$/i, ".zip");
  if (existsSync(join(outputDir, stdlibZipName))) {
    addUniquePathEntry(pthEntries, stdlibZipName);
  }
  addUniquePathEntry(pthEntries, ".");
  for (const line of normalizeEmbeddedPythonPathLines(lines)) {
    addUniquePathEntry(pthEntries, line);
  }
  addUniquePathEntry(pthEntries, "import site");
  return pthEntries;
}

function normalizeEmbeddedPythonPathLines(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter(
      (line) => line && line !== "import site" && line !== "#import site",
    );
}

function addUniquePathEntry(pthEntries: string[], entry: string): void {
  if (
    !entry ||
    pthEntries.some((line) => line.toLowerCase() === entry.toLowerCase())
  ) {
    return;
  }
  pthEntries.push(entry);
}

function isManagedFluxPackagePathLine(
  line: string,
  pythonDir: string,
  packageDir?: string,
): boolean {
  const trimmed = line.trim();
  if (isIgnoredPythonPathLine(trimmed)) {
    return false;
  }
  try {
    return isManagedFluxPackagePath(resolve(pythonDir, trimmed), packageDir);
  } catch (_error) {
    return false;
  }
}

function isIgnoredPythonPathLine(trimmed: string): boolean {
  return (
    !trimmed ||
    trimmed === "." ||
    trimmed === "import site" ||
    trimmed.startsWith("#")
  );
}

function isManagedFluxPackagePath(
  resolvedLine: string,
  packageDir?: string,
): boolean {
  if (packageDir && isPathInside(resolvedLine, packageDir)) {
    return true;
  }
  const baseName = basename(resolvedLine).toLowerCase();
  if (!baseName.startsWith("python-packages")) {
    return false;
  }
  const normalized = resolvedLine.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/mgt-flux-python-") ||
    normalized.includes("/models/inpainting/")
  );
}

function hasUsefulTrailingLine(
  line: string,
  index: number,
  array: string[],
): boolean {
  return index < array.length - 1 || Boolean(line.trim());
}
