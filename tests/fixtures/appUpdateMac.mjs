import assert from "node:assert/strict";
import { app } from "electron";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  createReadStream,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import ts from "typescript";

assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Disposable CI only");
const load = createRequire(import.meta.url);
load.extensions[".ts"] = (module, filename) => {
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  module._compile(compiled.outputText, filename);
};
const { AppUpdateDownload } = load("../../src/main/appUpdateDownload.ts");
const root = await mkdtemp(join(tmpdir(), "carrot-update-한글-"));
app.setPath("userData", root);
app.disableHardwareAcceleration();
const version = load("../../package.json").version;
const dmg = resolve(`dist/CarrotMangaTranslator-${version}-macOS-arm64.dmg`);
const name = basename(dmg);
const size = (await stat(dmg)).size;
const digest = createHash("sha256");
for await (const chunk of createReadStream(dmg)) digest.update(chunk);
const sha256 = digest.digest("hex");
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Length": size });
  createReadStream(dmg).pipe(res);
});
let mounted;
function mountedImages() {
  const plist = execFileSync("hdiutil", ["info", "-plist"]);
  return JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], {
      input: plist,
    }).toString(),
  ).images;
}
async function run() {
  try {
    await app.whenReady();
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const baseUrl = `http://127.0.0.1:${server.address().port}/`;
    const release = {
      version,
      tag: `v${version}`,
      baseUrl,
      name,
      url: baseUrl + name,
      size,
      sha256,
    };
    const download = new AppUpdateDownload(() => {});
    await download.download(release, new AbortController().signal, () => {});
    await download.install(release);
    const cachedDmg = realpathSync(join(root, "app-updates", version, name));
    const cachedIdentity = statSync(cachedDmg);
    const deadline = Date.now() + 90000;
    let images = [];
    while (Date.now() < deadline) {
      images = mountedImages();
      mounted = images.find((entry) => {
        try {
          // APFS/hdiutil can return decomposed Korean names even after realpath.
          // Compare the file itself, rather than the path's Unicode spelling.
          const identity = statSync(entry["image-path"]);
          return (
            identity.dev === cachedIdentity.dev &&
            identity.ino === cachedIdentity.ino
          );
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      });
      if (mounted) break;
      await new Promise((done) => setTimeout(done, 500));
    }
    assert.ok(
      mounted,
      `shell.openPath must mount ${cachedDmg}; observed images: ${JSON.stringify(images.map((entry) => entry["image-path"]))}`,
    );
    assert.ok(
      mounted["system-entities"].some((entry) => entry["mount-point"]),
      "The downloaded DMG must have a mounted volume",
    );
    await writeFile(
      "dist/mac-update-verification.json",
      JSON.stringify(
        {
          version,
          size,
          sha256,
          downloaded: true,
          verified: true,
          opened: true,
          cachedDmg,
          mountedImage: mounted["image-path"],
          source: "local HTTP server serving the real release DMG",
        },
        null,
        2,
      ),
    );
    console.log(
      "Production updater downloaded, verified and opened the real DMG.",
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (mounted) {
      const device = mounted["system-entities"].find(
        (entry) => entry["mount-point"],
      )?.["dev-entry"];
      if (device) execFileSync("hdiutil", ["detach", device]);
    }
    server.close();
    app.exit(process.exitCode ?? 0);
  }
}
void run();
