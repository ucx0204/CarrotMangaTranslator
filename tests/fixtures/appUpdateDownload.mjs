import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { app } from "electron";
import { createRequire } from "node:module";
const load = createRequire(import.meta.url);
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { readFileSync } from "node:fs";
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
const { AppUpdateWindows } = load("../../src/main/appUpdateWindows.ts");
const { ElectronHttpExecutor } = load(
  "electron-updater/out/electronHttpExecutor",
);
import assert from "node:assert/strict";
const root = process.env.MGT_UPDATE_TEST_ROOT;
if (!root) throw new Error("Missing isolated updater test root");
app.setPath("userData", root);
app.disableHardwareAcceleration();
let requests = 0;
let cancelOnRequest;
let cancelMetadata;
const bytes = Buffer.alloc(65536, 42);
let sha256 = createHash("sha256").update(bytes).digest("hex");
let sha512 = createHash("sha512").update(bytes).digest("base64");
let version = "3.8.0";
const name = () => `CarrotMangaTranslator-Setup-v${version}.exe`;
const server = createServer((req, res) => {
  if (req.url.startsWith("/latest.yml") && cancelMetadata) {
    cancelMetadata();
    return;
  }
  if (req.url.startsWith("/latest.yml"))
    return res.end(
      `version: ${version}\nfiles:\n  - url: ${name()}\n    size: ${bytes.length}\n    sha512: ${sha512}\npath: ${name()}\nsha512: ${sha512}\n`,
    );
  requests++;
  if (cancelOnRequest) {
    cancelOnRequest();
    return;
  }
  res.writeHead(200, { "Content-Length": bytes.length });
  res.end(bytes);
});
app
  .whenReady()
  .then(async () => {
    await fs.mkdir(root, { recursive: true });
    const config = join(root, "app-update.yml");
    await fs.writeFile(config, "updaterCacheDirName: isolated-updater\n");
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${server.address().port}/`;
    const adapter = {
      version: "3.7.8",
      name: "issue167-test",
      isPackaged: true,
      appUpdateConfigPath: config,
      userDataPath: root,
      baseCachePath: root,
      whenReady: () => Promise.resolve(),
      relaunch: () => assert.fail("Unexpected relaunch"),
      quit: () => assert.fail("Unexpected quit"),
      onQuit: () => {},
    };
    const create = () =>
      new AppUpdateDownload(
        () => {},
        (url) => {
          const updater = new AppUpdateWindows(null, adapter);
          updater.httpExecutor = new ElectronHttpExecutor();
          updater.logger = null;
          updater.setFeedURL({ provider: "generic", url });
          return updater;
        },
      );
    const release = () => ({
      version,
      tag: `v${version}`,
      baseUrl,
      name: name(),
      url: baseUrl + name(),
      size: bytes.length,
      sha256,
    });
    const first = create();
    await first.download(release(), new AbortController().signal, () => {});
    assert.equal(requests, 1);

    const realSpawn = childProcess.spawn;
    let launchCalls = 0;
    childProcess.spawn = (file, args) => {
      assert.equal(file, join(process.resourcesPath, "elevate.exe"));
      assert.deepEqual(args.slice(1), ["/S", "--updated", "--force-run"]);
      const child = new EventEmitter();
      child.unref = () => {};
      launchCalls++;
      // The bundled elevate.exe returns 1 when the user declines UAC.
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    };
    try {
      await assert.rejects(first.install(release()), /Elevation declined/);
      await assert.rejects(first.install(release()), /Elevation declined/);
      assert.equal(
        launchCalls,
        2,
        "UAC cancellation must permit a later explicit retry",
      );
    } finally {
      childProcess.spawn = realSpawn;
    }
    await create().download(release(), new AbortController().signal, () => {});
    assert.equal(requests, 1, "Restart must reuse verified cached file");
    await fs.writeFile(
      join(root, "isolated-updater", "pending", name()),
      Buffer.alloc(bytes.length, 99),
    );
    await create().download(release(), new AbortController().signal, () => {});
    assert.equal(requests, 2, "Corrupt cache must be replaced");
    version = "3.8.1";
    bytes.fill(66);
    sha256 = createHash("sha256").update(bytes).digest("hex");
    sha512 = createHash("sha512").update(bytes).digest("base64");
    const controller = new AbortController();
    cancelOnRequest = () => controller.abort();
    await assert.rejects(
      create().download(release(), controller.signal, () => {}),
    );
    assert.equal(requests, 3, "Cancellation must not retry");
    const checkAbort = new AbortController();
    cancelMetadata = () => checkAbort.abort();
    await assert.rejects(
      create().download(release(), checkAbort.signal, () => {}),
    );
    await fs.writeFile(
      join(root, "result.json"),
      JSON.stringify(
        {
          passed: true,
          downloadRequests: requests,
          cacheReuse: true,
          corruptCacheReplaced: true,
          cancellation: true,
          uacCancellation: true,
        },
        null,
        2,
      ),
    );
    console.log("update-download-smoke passed");
    server.closeAllConnections();
    server.close();
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    server.closeAllConnections();
    server.close();
    app.exit(1);
  });
