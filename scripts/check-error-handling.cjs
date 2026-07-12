// @ts-check
const { existsSync, readFileSync } = require("node:fs");
const { join, relative, extname } = require("node:path");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");

const EMPTY_CATCH_ALLOW_MARKER = "error-policy-allow:";
const CANDIDATE_EXTENSIONS = new Set([".cjs", ".mjs", ".js", ".ts", ".tsx"]);

/** @typedef {"promise-catch-undefined" | "promise-catch-empty-block" | "empty-catch-block" | "implicit-catch-sentinel"} RuleName */
/** @typedef {{ file: string, line: number, rule: RuleName }} Violation */

/** @type {Record<RuleName, string>} */
const ruleMessages = {
  "promise-catch-undefined":
    "Do not silently swallow promise failures with .catch(() => undefined).",
  "promise-catch-empty-block":
    "Do not silently swallow promise failures with an empty .catch callback.",
  "empty-catch-block": `A catch without executable handling needs an explicit '${EMPTY_CATCH_ALLOW_MARKER} reason' boundary marker.`,
  "implicit-catch-sentinel":
    "A catch that converts failure to a sentinel must explicitly mark the caught value as intentionally ignored (for example, catch (_error)) or handle it.",
};

function listCandidateFiles() {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "src",
      "scripts",
      "tests",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
  return output
    .split("\0")
    .filter((file) => file && CANDIDATE_EXTENSIONS.has(extname(file)));
}

/** @param {string} file */
function resolveScriptKind(file) {
  switch (extname(file)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".ts":
      return ts.ScriptKind.TS;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

/**
 * @param {import("typescript").CatchClause} node
 * @param {import("typescript").SourceFile} sourceFile
 */
function inspectCatchClause(node, sourceFile) {
  if (node.block.statements.length === 0) {
    return node.block.getFullText(sourceFile).includes(EMPTY_CATCH_ALLOW_MARKER)
      ? null
      : "empty-catch-block";
  }
  if (
    node.block.statements.length === 1 &&
    isSentinelReturn(node.block.statements[0]) &&
    !isExplicitlyIgnoredCatch(node)
  ) {
    return "implicit-catch-sentinel";
  }
  return null;
}

/** @param {import("typescript").Statement} statement */
function isSentinelReturn(statement) {
  if (!ts.isReturnStatement(statement)) {
    return false;
  }
  const value = statement.expression;
  return (
    !value ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(value) && value.text === "undefined") ||
    (ts.isArrayLiteralExpression(value) && value.elements.length === 0) ||
    (ts.isObjectLiteralExpression(value) && value.properties.length === 0)
  );
}

/** @param {import("typescript").CatchClause} node */
function isExplicitlyIgnoredCatch(node) {
  const variable = node.variableDeclaration;
  if (!variable || !ts.isIdentifier(variable.name)) {
    return false;
  }
  return variable.name.text.startsWith("_");
}

/** @param {import("typescript").Node} node */
function inspectPromiseCatch(node) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "catch"
  ) {
    return null;
  }
  const callback = node.arguments[0];
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
  ) {
    return null;
  }
  if (ts.isBlock(callback.body)) {
    if (callback.body.statements.length > 0) {
      return null;
    }
    return callback.body.getFullText().includes(EMPTY_CATCH_ALLOW_MARKER)
      ? null
      : "promise-catch-empty-block";
  }
  return ts.isIdentifier(callback.body) && callback.body.text === "undefined"
    ? "promise-catch-undefined"
    : null;
}

/** @type {Violation[]} */
const violations = [];
for (const file of listCandidateFiles()) {
  const absolutePath = join(process.cwd(), file);
  if (!existsSync(absolutePath)) {
    continue;
  }
  const sourceText = readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    resolveScriptKind(file),
  );

  /** @param {import("typescript").Node} node */
  function visit(node) {
    const rule = ts.isCatchClause(node)
      ? inspectCatchClause(node, sourceFile)
      : inspectPromiseCatch(node);
    if (rule) {
      const position = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      violations.push({
        file: relative(process.cwd(), absolutePath),
        line: position.line + 1,
        rule,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

if (violations.length > 0) {
  console.error("Error handling policy failed:");
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.line} ${violation.rule}: ${ruleMessages[violation.rule]}`,
    );
  }
  process.exit(1);
}

console.log("error handling policy passed");
