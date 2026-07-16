const { existsSync, readdirSync, statSync } = require("node:fs");
const { join, relative, sep } = require("node:path");

const WINDOWS_EXECUTABLE_BASENAME = "CarrotMangaTranslator";
const WINDOWS_EXECUTABLE_FILENAME = `${WINDOWS_EXECUTABLE_BASENAME}.exe`;
const MAX_FAST_ZIP_INSTALL_DIR_LENGTH = 160;
const MAX_FAST_ZIP_DESTINATION_PATH_LENGTH = 240;
const MAX_FAST_ZIP_RELATIVE_PATH_LENGTH =
  MAX_FAST_ZIP_DESTINATION_PATH_LENGTH - MAX_FAST_ZIP_INSTALL_DIR_LENGTH - 1;
const ASCII_ZIP_ENTRY_PATTERN = /^[\x20-\x7e]+$/;

/**
 * nsisunz converts ZIP entry names with the Windows ANSI code page instead
 * of honoring the ZIP UTF-8 flag. Keep every payload entry ASCII-only so a
 * localized product name cannot turn into an invalid Windows path.
 *
 * nsisunz also uses MAX_PATH-sized buffers. The installer separately limits
 * $INSTDIR to MAX_FAST_ZIP_INSTALL_DIR_LENGTH; keep enough room here for the
 * longest packaged relative path.
 *
 * @param {string} appOutDir
 * @returns {{ entries: number; maxRelativePathLength: number }}
 */
function assertFastZipPayload(appOutDir) {
  const executablePath = join(appOutDir, WINDOWS_EXECUTABLE_FILENAME);
  if (!existsSync(executablePath) || !statSync(executablePath).isFile()) {
    throw new Error(
      `Fast ZIP payload is missing its ASCII executable: ${executablePath}`,
    );
  }

  /** @type {string[]} */
  const incompatibleEntries = [];
  /** @type {string[]} */
  const tooLongEntries = [];
  let entries = 0;
  let maxRelativePathLength = 0;

  walkPayload(appOutDir, (entryPath) => {
    const relativePath = relative(appOutDir, entryPath).split(sep).join("/");
    entries += 1;
    maxRelativePathLength = Math.max(
      maxRelativePathLength,
      relativePath.length,
    );

    if (!ASCII_ZIP_ENTRY_PATTERN.test(relativePath)) {
      incompatibleEntries.push(relativePath);
    }
    if (relativePath.length > MAX_FAST_ZIP_RELATIVE_PATH_LENGTH) {
      tooLongEntries.push(relativePath);
    }
  });

  if (incompatibleEntries.length > 0) {
    throw new Error(
      [
        "Fast ZIP payload contains non-ASCII paths that nsisunz cannot safely extract:",
        ...incompatibleEntries.slice(0, 10),
      ].join("\n"),
    );
  }
  if (tooLongEntries.length > 0) {
    throw new Error(
      [
        `Fast ZIP payload paths exceed the ${MAX_FAST_ZIP_RELATIVE_PATH_LENGTH}-character safety budget:`,
        ...tooLongEntries.slice(0, 10),
      ].join("\n"),
    );
  }

  return { entries, maxRelativePathLength };
}

/**
 * @param {string} directory
 * @param {(entryPath: string) => void} visit
 */
function walkPayload(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Fast ZIP payload must not contain symbolic links: ${entryPath}`,
      );
    }
    visit(entryPath);
    if (entry.isDirectory()) {
      walkPayload(entryPath, visit);
    }
  }
}

module.exports = {
  MAX_FAST_ZIP_DESTINATION_PATH_LENGTH,
  MAX_FAST_ZIP_INSTALL_DIR_LENGTH,
  MAX_FAST_ZIP_RELATIVE_PATH_LENGTH,
  WINDOWS_EXECUTABLE_BASENAME,
  WINDOWS_EXECUTABLE_FILENAME,
  assertFastZipPayload,
};
