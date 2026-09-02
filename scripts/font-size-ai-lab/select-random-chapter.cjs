#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- isolated experiment/audit utility; production types remain checked.
"use strict";

/** Seal one reproducibly random, never-before-used Tachidesk chapter. */

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

function parseArgs(argv) {
  const args = {
    excludeKeys: [],
    historyManifests: [],
    output: null,
    registry: path.resolve("docs/font-size-ai-lab-used-chapters.json"),
    root: null,
    seed: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root") args.root = path.resolve(argv[++index]);
    else if (value === "--registry")
      args.registry = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--seed") args.seed = String(argv[++index]);
    else if (value === "--history-manifest") {
      args.historyManifests.push(path.resolve(argv[++index]));
    } else if (value === "--exclude-key") {
      args.excludeKeys.push(String(argv[++index]));
    } else if (value === "--help") {
      console.log(
        "Usage: node scripts/font-size-ai-lab/select-random-chapter.cjs " +
          "--root PATH --output PATH [--registry PATH] [--seed HEX] " +
          "[--history-manifest PATH] [--exclude-key provider/series/chapter]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.root || !args.output)
    throw new Error("--root and --output are required.");
  return args;
}

function normalizeKey(value) {
  return String(value)
    .normalize("NFKC")
    .replaceAll("\\", "/")
    .toLocaleLowerCase("en-US");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function directoryNames(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "ja"));
}

function imageNames(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "ja", { numeric: true }));
}

function discoverChapters(root) {
  const chapters = [];
  for (const provider of directoryNames(root)) {
    const providerPath = path.join(root, provider);
    for (const series of directoryNames(providerPath)) {
      const seriesPath = path.join(providerPath, series);
      for (const chapter of directoryNames(seriesPath)) {
        const chapterPath = path.join(seriesPath, chapter);
        const images = imageNames(chapterPath);
        if (images.length === 0) continue;
        const key = `${provider}/${series}/${chapter}`;
        chapters.push({
          chapter,
          key,
          normalizedKey: normalizeKey(key),
          pageCount: images.length,
          path: chapterPath,
          provider,
          series,
          images,
        });
      }
    }
  }
  return chapters.sort((left, right) =>
    left.normalizedKey.localeCompare(right.normalizedKey),
  );
}

function historicalKeys(manifestPath) {
  const payload = readJson(manifestPath);
  return (Array.isArray(payload.items) ? payload.items : []).flatMap((item) => {
    const parts = String(item.relativePath ?? "").split("/");
    return parts.length >= 3 ? [parts.slice(0, 3).join("/")] : [];
  });
}

function defaultRegistry() {
  return {
    schemaVersion: 1,
    policy: "never-reuse-even-after-failure-or-interruption",
    historicalExclusions: [],
    selections: [],
  };
}

function selectionRank(seed, normalizedKey) {
  return crypto
    .createHash("sha256")
    .update(seed)
    .update("\0")
    .update(normalizedKey)
    .digest("hex");
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, filePath);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.statSync(args.root).isDirectory())
    throw new Error(`Root is not a directory: ${args.root}`);
  if (fs.existsSync(args.output))
    throw new Error(`Selection output already exists: ${args.output}`);

  const registry = fs.existsSync(args.registry)
    ? readJson(args.registry)
    : defaultRegistry();
  const historical = new Map(
    (registry.historicalExclusions ?? []).map((entry) => [
      entry.normalizedKey,
      entry,
    ]),
  );
  for (const manifestPath of args.historyManifests) {
    for (const key of historicalKeys(manifestPath)) {
      const normalizedKey = normalizeKey(key);
      historical.set(normalizedKey, {
        key,
        normalizedKey,
        reason: "historical-koharu-or-font-size-evaluation",
        sourceManifest: manifestPath,
      });
    }
  }
  for (const key of args.excludeKeys) {
    const normalizedKey = normalizeKey(key);
    historical.set(normalizedKey, {
      key,
      normalizedKey,
      reason: "explicit-prior-use-exclusion",
      sourceManifest: null,
    });
  }

  const used = new Set([
    ...historical.keys(),
    ...(registry.selections ?? []).map((entry) => entry.normalizedKey),
  ]);
  const inventory = discoverChapters(args.root);
  const eligible = inventory.filter((entry) => !used.has(entry.normalizedKey));
  if (eligible.length === 0)
    throw new Error("No unused Tachidesk chapters remain.");
  const seed = args.seed ?? crypto.randomBytes(32).toString("hex");
  const ranked = eligible
    .map((entry) => ({
      ...entry,
      selectionRank: selectionRank(seed, entry.normalizedKey),
    }))
    .sort((left, right) =>
      left.selectionRank.localeCompare(right.selectionRank),
    );
  const chosen = ranked[0];
  const inventoryDigest = crypto
    .createHash("sha256")
    .update(
      inventory
        .map((entry) => `${entry.normalizedKey}\t${entry.pageCount}`)
        .join("\n"),
    )
    .digest("hex");
  const pages = chosen.images.map((name, index) => {
    const imagePath = path.join(chosen.path, name);
    const stats = fs.statSync(imagePath);
    return {
      byteSize: stats.size,
      index: index + 1,
      name,
      path: imagePath,
      sha256: sha256File(imagePath),
    };
  });
  const sealedAt = new Date().toISOString();
  const selection = {
    schemaVersion: 1,
    campaign: "font-size-ai-hayai-ocr",
    sealedAt,
    seed,
    inventoryDigest,
    inventoryCount: inventory.length,
    excludedCount: inventory.length - eligible.length,
    eligibleCount: eligible.length,
    selectionRank: chosen.selectionRank,
    key: chosen.key,
    normalizedKey: chosen.normalizedKey,
    provider: chosen.provider,
    series: chosen.series,
    chapter: chosen.chapter,
    path: chosen.path,
    pageCount: chosen.pageCount,
    pages,
    experimentsUsed: 0,
    experimentLimit: 5,
    status: "sealed-before-visual-inspection",
  };
  registry.historicalExclusions = [...historical.values()].sort((left, right) =>
    left.normalizedKey.localeCompare(right.normalizedKey),
  );
  registry.selections = [
    ...(registry.selections ?? []),
    {
      chapter: selection.chapter,
      experimentsUsed: 0,
      key: selection.key,
      normalizedKey: selection.normalizedKey,
      pageCount: selection.pageCount,
      provider: selection.provider,
      report: null,
      sealedAt,
      seed,
      series: selection.series,
      status: selection.status,
    },
  ];
  await writeJsonAtomic(args.registry, registry);
  await writeJsonAtomic(args.output, selection);
  process.stdout.write(
    `${JSON.stringify(
      {
        chapter: selection.chapter,
        eligibleCount: selection.eligibleCount,
        key: selection.key,
        output: args.output,
        pageCount: selection.pageCount,
        registry: args.registry,
        seed: selection.seed,
        series: selection.series,
      },
      null,
      2,
    )}\n`,
  );
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
