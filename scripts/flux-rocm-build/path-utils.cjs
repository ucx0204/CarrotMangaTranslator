const { statSync } = require("node:fs");
const { isAbsolute, relative, resolve } = require("node:path");

/** @param {unknown} pathValue */
function isDirectory(pathValue) {
  try {
    return statSync(String(pathValue || "")).isDirectory();
  } catch (error) {
    void error;
    return false;
  }
}

/** @param {unknown} pathValue */
function isFile(pathValue) {
  try {
    return statSync(String(pathValue || "")).isFile();
  } catch (error) {
    void error;
    return false;
  }
}

/** @param {unknown} pathValue */
function toCmakePath(pathValue) {
  return resolve(String(pathValue || "")).replace(/\\/g, "/");
}

/** @param {string} child @param {string} parent */
function isPathInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

module.exports = { isDirectory, isFile, isPathInside, toCmakePath };
