const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { basename, dirname, join, resolve } = require("node:path");

const projectRoot = resolve(__dirname, "..");
const rootStylesheet = join(
  projectRoot,
  "src",
  "renderer",
  "src",
  "styles.css",
);
const domainDirectory = join(dirname(rootStylesheet), "styles");
const maxDomainLines = 1_200;
const expectedImports = [
  "fonts.css",
  "foundations.css",
  "shell-workspace.css",
  "panels.css",
  "page-review.css",
  "library-inpainting.css",
  "formatting.css",
  "stage-overlay.css",
  "modals-share.css",
  "settings.css",
  "gather-selection.css",
  "style-guide.css",
  "translate-picker.css",
];

function inspectCssStructure() {
  /** @type {string[]} */
  const violations = [];
  const rootSource = readFileSync(rootStylesheet, "utf8");
  const imports = parseRootImports(rootSource, violations);

  if (
    imports.length !== expectedImports.length ||
    imports.some((name, index) => name !== expectedImports[index])
  ) {
    violations.push(
      `styles.css must import the domain stylesheets once in this order: ${expectedImports.join(", ")}`,
    );
  }

  const actualFiles = readdirSync(domainDirectory)
    .filter((name) => name.endsWith(".css"))
    .sort();
  const expectedFiles = [...expectedImports].sort();
  if (actualFiles.join("\n") !== expectedFiles.join("\n")) {
    violations.push(
      `styles/ must contain exactly the imported domain stylesheets (found: ${actualFiles.join(", ")})`,
    );
  }

  for (const fileName of expectedImports) {
    inspectDomainStylesheet(fileName, violations);
  }
  return violations;
}

/**
 * @param {string} source
 * @param {string[]} violations
 * @returns {string[]}
 */
function parseRootImports(source, violations) {
  const imports = [];
  const seen = new Set();
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const match = /^@import "\.\/styles\/([^"]+)";$/.exec(line);
    if (!match) {
      violations.push(
        `styles.css:${index + 1} may contain only direct domain @import statements`,
      );
      continue;
    }
    const fileName = match[1];
    if (seen.has(fileName)) {
      violations.push(`styles.css imports ${fileName} more than once`);
    }
    seen.add(fileName);
    imports.push(fileName);
  }
  return imports;
}

/** @param {string} fileName @param {string[]} violations */
function inspectDomainStylesheet(fileName, violations) {
  const filePath = join(domainDirectory, fileName);
  if (!existsSync(filePath)) {
    violations.push(`missing domain stylesheet: ${fileName}`);
    return;
  }
  const source = readFileSync(filePath, "utf8");
  const lineCount =
    source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0);
  if (lineCount > maxDomainLines) {
    violations.push(
      `${fileName} has ${lineCount} lines; maximum is ${maxDomainLines}`,
    );
  }
  if (/@import\b/.test(stripComments(source))) {
    violations.push(
      `${fileName} must not re-export or import another stylesheet; styles.css owns ordering`,
    );
  }
  inspectSyntax(source, fileName, violations);
  inspectAssetReferences(source, filePath, violations);
}

/** @param {string} source */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * @param {string} source
 * @param {string} fileName
 * @param {string[]} violations
 */
function inspectSyntax(source, fileName, violations) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let inComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inComment) {
      if (character === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "*") {
      inComment = true;
      index += 1;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth < 0) {
        violations.push(`${fileName} has an unmatched closing brace`);
        return;
      }
    }
  }
  if (inComment) violations.push(`${fileName} has an unterminated comment`);
  if (quote) violations.push(`${fileName} has an unterminated string`);
  if (depth !== 0) violations.push(`${fileName} has unbalanced braces`);
}

/**
 * @param {string} source
 * @param {string} filePath
 * @param {string[]} violations
 */
function inspectAssetReferences(source, filePath, violations) {
  const urls = source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g);
  for (const match of urls) {
    const reference = match[1];
    if (
      reference.startsWith("data:") ||
      reference.startsWith("http:") ||
      reference.startsWith("https:") ||
      reference.startsWith("mgt-font:")
    ) {
      // mgt-font:///<rel> 빌트인 폰트는 mgt-font 핸들이 Node fs로 서빙한다(#53).
      // 존재 검증은 tests/bundledFontAssets.test.ts가 담당한다.
      continue;
    }
    const assetPath = resolve(dirname(filePath), reference);
    if (!existsSync(assetPath)) {
      violations.push(
        `${basename(filePath)} references missing asset: ${reference}`,
      );
    }
  }
}

function main() {
  const violations = inspectCssStructure();
  if (violations.length > 0) {
    process.stderr.write(
      `CSS structure check failed:\n${violations.map((item) => `- ${item}`).join("\n")}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `CSS structure check passed (${expectedImports.length} domain files, max ${maxDomainLines} lines).\n`,
  );
}

if (require.main === module) main();

module.exports = {
  expectedImports,
  inspectCssStructure,
  inspectSyntax,
  maxDomainLines,
  parseRootImports,
};
