const { dirname, isAbsolute, join, relative, resolve } = require("node:path");
const { realpathSync, writeFileSync } = require("node:fs");
const ts = require("typescript");

/**
 * Keep each compiled module's filesystem identity after bundling. Workers and
 * createRequire must still resolve beside that module, not beside bootstrap.
 * Only rewrite actual require.resolve calls, never strings or comments.
 * @param {string} code
 * @param {string} modulePath
 * @param {string} bundleDirectory
 */
function preserveModulePaths(code, modulePath, bundleDirectory) {
  const source = ts.createSourceFile(modulePath, code, ts.ScriptTarget.Latest);
  /** @type {{ start: number; end: number }[]} */
  const replacements = [];
  /** @param {import("typescript").Node} node */
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "require" &&
      node.expression.name.text === "resolve"
    ) {
      replacements.push({
        start: node.expression.getStart(source),
        end: node.expression.getEnd(),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const { start, end } of replacements.reverse()) {
    code =
      code.slice(0, start) +
      'require("node:module").createRequire(__filename).resolve' +
      code.slice(end);
  }
  const moduleRelativePath = relative(bundleDirectory, modulePath);
  return (
    `const __filename = require("node:path").resolve(__mgtDevBundleDirectory, ${JSON.stringify(moduleRelativePath)});\n` +
    'const __dirname = require("node:path").dirname(__filename);\n' +
    code
  );
}

/** Bundle only development startup; emitted worker files remain available.
 * @param {string} root
 */
async function bundleDevMain(root) {
  const { build } = await import("vite");
  // Vite resolves module IDs through symlinks (including macOS /var).
  // Compare and preserve paths against that same canonical output root.
  const outputRoot = realpathSync(resolve(root, "out"));
  const entry = join(outputRoot, "main", "bootstrap.js");
  const result = await build({
    configFile: false,
    publicDir: false,
    plugins: [
      {
        name: "dev-main-module-paths",
        transform(code, id) {
          const child = relative(outputRoot, id);
          if (
            isAbsolute(child) ||
            child.startsWith("..") ||
            !/\.(?:c?js)$/.test(id)
          )
            return;
          return {
            code: preserveModulePaths(code, id, dirname(entry)),
            map: null,
          };
        },
      },
    ],
    build: {
      ssr: entry,
      write: false,
      sourcemap: true,
      minify: false,
      rollupOptions: {
        // Native dependencies and installed packages retain Node resolution.
        external: (id) => !id.startsWith(".") && !isAbsolute(id),
        output: {
          format: "cjs",
          codeSplitting: false,
          banner: "const __mgtDevBundleDirectory = __dirname;",
        },
      },
    },
  });
  const built = Array.isArray(result) ? result[0] : result;
  if (!("output" in built))
    throw new Error("Unexpected development watch build.");
  const outputs = built.output;
  const chunks = outputs.filter((item) => item.type === "chunk");
  if (chunks.length !== 1 || !chunks[0].map) {
    throw new Error("Development main bundle must contain one mapped chunk.");
  }
  writeFileSync(entry, chunks[0].code);
  writeFileSync(`${entry}.map`, chunks[0].map.toString());
}

module.exports = { bundleDevMain, preserveModulePaths };
