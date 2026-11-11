import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

const { bundleDevMain, preserveModulePaths } =
  require("../scripts/bundle-dev-main.cjs") as {
    bundleDevMain(root: string): Promise<void>;
    preserveModulePaths(
      code: string,
      modulePath: string,
      bundleDirectory: string,
    ): string;
  };
const { createElectronCompileCacheStep } =
  require("../scripts/dev-build-cache.cjs") as {
    createElectronCompileCacheStep(
      root: string,
      options?: { devBundle: boolean },
    ): { fingerprintSalt: string };
  };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), "dev-main-bundle-")))
      throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});

it("preserves boot ordering, shared state, runtime paths and native worker resolution", async () => {
  const root = mkdtempSync(join(tmpdir(), "dev-main-bundle-"));
  roots.push(root);
  const main = join(root, "out", "main");
  mkdirSync(join(main, "nested"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(main, "state.js"), "exports.ready = false;");
  writeFileSync(
    join(main, "nested", "worker.js"),
    "module.exports = 'worker';",
  );
  writeFileSync(
    join(main, "nested", "thread.js"),
    "require('node:worker_threads').parentPort.postMessage('thread-ready');",
  );
  writeFileSync(
    join(main, "nested", "paths.js"),
    `
    const {createRequire} = require('node:module');
    if (!require('../state').ready) throw Error('Initialization reordered');
    const dynamic = './worker.js';
    module.exports = { file: __filename, directory: __dirname,
      worker: require.resolve('./worker.js'), dynamic: require.resolve(dynamic),
      thread: require.resolve('./thread.js'),
      value: createRequire(__filename)('./worker.js') };
  `,
  );
  writeFileSync(
    join(main, "bootstrap.js"),
    "require('./state').ready = true; const paths = require('./nested/paths'); new (require('node:worker_threads').Worker)(paths.thread).once('message', message => { if (message !== 'thread-ready') throw Error('Worker failed'); console.log(JSON.stringify(paths)); });",
  );
  const run = () =>
    spawnSync(process.execPath, [join(main, "bootstrap.js")], {
      encoding: "utf8",
    });
  const before = run();
  expect(before.status).toBe(0);
  await bundleDevMain(root);
  const after = run();
  expect(after.stderr).toBe("");
  expect(after.status).toBe(0);
  expect(JSON.parse(after.stdout)).toEqual(JSON.parse(before.stdout));
  expect(readFileSync(join(main, "bootstrap.js.map"), "utf8")).toContain(
    "paths.js",
  );
});

it("does not rewrite strings/comments and separates production and dev cache identities", () => {
  const code =
    'const text = "require.resolve(foo)"; // require.resolve(bar)\nrequire.resolve("./worker.js");';
  const result = preserveModulePaths(
    code,
    join(tmpdir(), "nested", "file.js"),
    tmpdir(),
  );
  expect(result).toContain('"require.resolve(foo)"');
  expect(result).toContain("// require.resolve(bar)");
  expect(result).toContain('createRequire(__filename).resolve("./worker.js")');
  expect(
    createElectronCompileCacheStep(process.cwd(), { devBundle: true })
      .fingerprintSalt,
  ).not.toBe(createElectronCompileCacheStep(process.cwd()).fingerprintSalt);
});
