const { existsSync, readFileSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  extractSelectedZipEntries,
} = require("../src/main/runtime/simple-page-zip-utils.cjs");

async function main() {
  const releaseDir = resolve(process.argv[2]);
  const outputRoot = resolve(process.argv[3]);
  if (existsSync(outputRoot))
    throw new Error("Use a fresh archive validation directory");
  const manifest = JSON.parse(
    readFileSync(join(releaseDir, "release-manifest.json"), "utf8"),
  );
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    const file = join(releaseDir, entry.archive.path);
    const data = readFileSync(file);
    if (
      data.length !== entry.archive.bytes ||
      createHash("sha256").update(data).digest("hex") !== entry.archive.sha256
    )
      throw new Error("Archive digest mismatch");
    const target = join(outputRoot, platform);
    await extractSelectedZipEntries(file, target, () => true, {
      preserveRelativePaths: true,
      replaceOutputDir: true,
    });
    const probe = spawnSync(
      "python",
      [
        "-c",
        [
          "import importlib.util,json,sys",
          "from pathlib import Path",
          "spec=importlib.util.spec_from_file_location('verify',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
          "root=Path(sys.argv[2]); rows=m.verify(root,json.loads((root/'ownership.json').read_text('utf-8')))",
          "print(json.dumps({'files':len(rows),'verified':True}))",
        ].join("\n"),
        join(__dirname, "install-font-chapter-c18-local.py"),
        target,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (probe.error || probe.status !== 0)
      throw probe.error ?? new Error(probe.stderr);
    console.log(platform, probe.stdout.trim());
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
