const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require("node:fs");
const { builtinModules } = require("node:module");
const { basename, dirname, join, resolve, sep } = require("node:path");
const { pathToFileURL } = require("node:url");

const OPENAI_OAUTH_RUNTIME_FILENAME = "openai-oauth-runtime.mjs";
const OPENAI_OAUTH_LICENSES_FILENAME = "openai-oauth-runtime-LICENSES.txt";
const OPTIONAL_SCHEMA_PACKAGES = ["effect", "@valibot/to-json-schema"];

/**
 * Bundle the native ESM OAuth runtime into one external resource.
 *
 * Electron's native ESM loader cannot reliably traverse dependencies inside
 * app.asar, which previously forced every production node_module into
 * app.asar.unpacked. Keeping one bundled ESM file outside ASAR removes
 * thousands of small installer writes while preserving the native import path.
 *
 * @param {{ root?: string; outputFile?: string }} [options]
 */
async function bundleOpenAIOAuthRuntime(options = {}) {
  const root = resolve(options.root ?? join(__dirname, ".."));
  const entryFile = join(
    root,
    "node_modules",
    "openai-oauth",
    "dist",
    "index.js",
  );
  const outputFile = resolve(
    options.outputFile ??
      join(root, "out", "app-runtime", OPENAI_OAUTH_RUNTIME_FILENAME),
  );

  if (!existsSync(entryFile)) {
    throw new Error(`openai-oauth runtime entry is missing: ${entryFile}`);
  }
  mkdirSync(dirname(outputFile), { recursive: true });

  const { build } = await import("rolldown");
  const buildResult = await build({
    input: entryFile,
    platform: "node",
    external: [
      ...builtinModules,
      ...builtinModules.map((name) => `node:${name}`),
      ...OPTIONAL_SCHEMA_PACKAGES,
    ],
    treeshake: true,
    output: {
      dir: dirname(outputFile),
      entryFileNames: basename(outputFile),
      format: "esm",
      codeSplitting: false,
      minify: false,
      sourcemap: false,
    },
  });
  writeBundledPackageLicenses(
    buildResult.output.flatMap((output) =>
      output.type === "chunk" ? Object.keys(output.modules) : [],
    ),
    join(dirname(outputFile), OPENAI_OAUTH_LICENSES_FILENAME),
  );

  if (!existsSync(outputFile)) {
    throw new Error(`OAuth runtime bundle was not created: ${outputFile}`);
  }

  const runtime = await import(
    `${pathToFileURL(outputFile).href}?verify=${Date.now()}`
  );
  if (typeof runtime.startOpenAIOAuthServer !== "function") {
    throw new Error(
      "OAuth runtime bundle does not export startOpenAIOAuthServer.",
    );
  }

  return outputFile;
}

/**
 * Keep the license texts that used to travel with the packaged node_modules.
 * The generated file is deterministic and follows the exact modules Rolldown
 * included, so dependency updates cannot silently drop required notices.
 *
 * @param {string[]} moduleIds
 * @param {string} outputFile
 */
function writeBundledPackageLicenses(moduleIds, outputFile) {
  const packageRoots = new Set();
  for (const moduleId of moduleIds) {
    const packageRoot = resolvePackageRootFromModule(moduleId);
    if (packageRoot) {
      packageRoots.add(packageRoot);
    }
  }

  const packages = [...packageRoots]
    .map((packageRoot) => {
      const packageJson = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
      );
      const licenseFiles = readdirSync(packageRoot)
        .filter((fileName) =>
          /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(fileName),
        )
        .sort((left, right) => left.localeCompare(right, "en"));
      return {
        name: String(packageJson.name ?? basename(packageRoot)),
        version: String(packageJson.version ?? "unknown"),
        license: normalizeDeclaredLicense(packageJson.license),
        repository: normalizeRepository(packageJson.repository),
        packageRoot,
        licenseFiles,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));

  const sections = packages.map((item) => {
    const header = [
      `Package: ${item.name}@${item.version}`,
      `Declared license: ${item.license}`,
      ...(item.repository ? [`Source: ${item.repository}`] : []),
    ];
    const texts = item.licenseFiles.map((fileName) => {
      const text = readFileSync(
        join(item.packageRoot, fileName),
        "utf8",
      ).trim();
      return [`--- ${fileName} ---`, text].join("\n");
    });
    return [...header, ...texts].join("\n");
  });

  writeFileSync(
    outputFile,
    [
      "Bundled OpenAI OAuth runtime third-party licenses",
      "",
      "This file is generated from the exact packages included in openai-oauth-runtime.mjs.",
      "",
      sections.join("\n\n" + "=".repeat(78) + "\n\n"),
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * @param {string} moduleId
 */
function resolvePackageRootFromModule(moduleId) {
  if (!moduleId || moduleId.startsWith("\0")) {
    return null;
  }
  const marker = `${sep}node_modules${sep}`;
  const markerIndex = moduleId.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const nodeModulesRoot = moduleId.slice(0, markerIndex + marker.length);
  const relativeModulePath = moduleId.slice(markerIndex + marker.length);
  const parts = relativeModulePath.split(sep);
  const packageParts = parts[0]?.startsWith("@")
    ? parts.slice(0, 2)
    : parts.slice(0, 1);
  if (
    packageParts.length === 0 ||
    packageParts.some((part) => !part || part === "." || part === "..")
  ) {
    return null;
  }
  const packageRoot = join(nodeModulesRoot, ...packageParts);
  return existsSync(join(packageRoot, "package.json")) ? packageRoot : null;
}

/**
 * @param {unknown} value
 */
function normalizeDeclaredLicense(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const licenses = value
      .map((item) =>
        typeof item === "string"
          ? item
          : typeof item === "object" &&
              item !== null &&
              "type" in item &&
              typeof item.type === "string"
            ? item.type
            : "",
      )
      .filter(Boolean);
    if (licenses.length > 0) {
      return licenses.join(" OR ");
    }
  }
  return "not declared";
}

/**
 * @param {unknown} value
 */
function normalizeRepository(value) {
  const repository =
    typeof value === "string"
      ? value
      : typeof value === "object" &&
          value !== null &&
          "url" in value &&
          typeof value.url === "string"
        ? value.url
        : "";
  return repository
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
}

module.exports = {
  OPENAI_OAUTH_LICENSES_FILENAME,
  OPENAI_OAUTH_RUNTIME_FILENAME,
  bundleOpenAIOAuthRuntime,
  resolvePackageRootFromModule,
  writeBundledPackageLicenses,
};

if (require.main === module) {
  bundleOpenAIOAuthRuntime()
    .then((outputFile) => {
      console.log(`[runtime] bundled ${outputFile}`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
