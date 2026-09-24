import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

// A real isolated Node process is necessary: collection must occur AFTER the
// timeout wrapper settled and BEFORE the retained decoder signal is inspected.
// Only timer scheduling is controlled; AbortController/Signal and GC are native.
const scenario = String.raw`
const assert = require('node:assert/strict');
const { setImmediate: turn } = require('node:timers/promises');
const { withAbortableTimeout } = require(process.argv[1]);
(async () => {
  const original = { setTimeout, clearTimeout };
  const timers = new Map(); let sequence = 0;
  global.setTimeout = callback => { timers.set(++sequence, callback); return sequence; };
  global.clearTimeout = id => timers.delete(id);
  try {
    const parent = new AbortController();
    let decoderSignal;
    const pending = withAbortableTimeout(signal => {
      decoderSignal = signal;
      return new Promise(() => {});
    }, 60000, 'decoder deadline', parent.signal).catch(error => error);
    await turn();
    assert.equal(timers.size, 1);
    [...timers.values()][0]();
    assert.equal((await pending).message, 'decoder deadline');
    for (let cycle = 0; cycle < 4; cycle++) { await turn(); global.gc(); }
    assert.equal(decoderSignal.aborted, true, 'Timed-out decoder must remain cancelled after cleanup/GC');
    assert.equal(decoderSignal.reason.message, 'decoder deadline');
    assert.equal(parent.signal.aborted, false, 'Child timeout must not cancel its parent');
    assert.equal(timers.size, 0);
    console.log('PASS retained decoder cancellation after native GC');
  } finally { Object.assign(global, original); }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

it("preserves decoder cancellation after timeout cleanup and native garbage collection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mgt-export-timeout-gc-"));
  try {
    // Compile the complete existing modules without replacing internal functions.
    // This test is independent of a stale out/ build or the current worker's GC flags.
    for (const relative of [
      "pageExportLifecycle.ts",
      "runtimeSupport/observeProcessErrors.ts",
    ]) {
      const source = await readFile(
        join(__dirname, "../src/main", relative),
        "utf8",
      );
      const target = join(directory, relative.replace(/\.ts$/, ".js"));
      await mkdir(dirname(target), { recursive: true });
      const result = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
        fileName: relative,
      });
      await writeFile(target, result.outputText);
    }
    const output = execFileSync(
      process.execPath,
      [
        "--expose-gc",
        "-e",
        scenario,
        join(directory, "pageExportLifecycle.js"),
      ],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    expect(output).toContain(
      "PASS retained decoder cancellation after native GC",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
