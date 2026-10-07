import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runRuntimeCliProbe,
  createRuntimeCliProbe,
} = require("../scripts/llama-runtime-cli-probe.cjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function logPath() {
  const root = mkdtempSync(join(tmpdir(), "mgt-cli-probe-"));
  roots.push(root);
  return join(root, "probe.log");
}

describe("native CLI probe diagnostics", () => {
  it("reuses only identical successful invocations and preserves per-case evidence", () => {
    const spawn = vi.fn(() => ({ status: 0, output: "parser ready" }));
    const run = createRuntimeCliProbe(spawn);
    const first = logPath(),
      reused = logPath();
    run("server", ["--help"], { env: { A: "1", B: "2" }, logPath: first });
    run("server", ["--help"], { env: { B: "2", A: "1" }, logPath: reused });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(readFileSync(reused, "utf8")).toContain(JSON.stringify(first));
    expect(readFileSync(reused, "utf8")).toContain("parser ready");
    for (const [server, args, env, timeoutMs] of [
      ["other", ["--help"], { A: "1", B: "2" }, undefined],
      ["server", ["--version"], { A: "1", B: "2" }, undefined],
      ["server", ["--help"], { A: "3", B: "2" }, undefined],
      ["server", ["--help"], { A: "1", B: "2" }, 50],
    ] as const)
      run(server, args, { env, timeoutMs, logPath: logPath() });
    expect(spawn).toHaveBeenCalledTimes(5);
    spawn.mockReturnValue({ status: 9, output: "rejected" });
    for (let i = 0; i < 2; i++) run("bad", [], { env: {}, logPath: logPath() });
    expect(spawn).toHaveBeenCalledTimes(7);
  });
  it("retains stdout and stderr from a completed native command", () => {
    const file = logPath();
    const result = runRuntimeCliProbe(
      process.execPath,
      ["-e", "console.log('--help'); console.error('loader ready')"],
      {
        env: process.env,
        logPath: file,
      },
    );
    expect(result.status).toBe(0);
    expect(result.output).toContain("--help");
    expect(readFileSync(file, "utf8")).toContain("loader ready");
  });

  it("preserves a rejected argument's exit code for the caller to validate", () => {
    const file = logPath();
    const result = runRuntimeCliProbe(
      process.execPath,
      ["-e", "console.error('unsupported argument'); process.exitCode = 9"],
      {
        env: process.env,
        logPath: file,
      },
    );
    expect(result.status).toBe(9);
    expect(readFileSync(file, "utf8")).toContain('"status":9');
  });

  it("fails a hanging child and saves its partial output instead of treating help text as success", () => {
    const file = logPath();
    expect(() =>
      runRuntimeCliProbe(
        process.execPath,
        [
          "-e",
          "console.log('--help printed before hang'); setInterval(() => {}, 1000)",
        ],
        {
          env: process.env,
          logPath: file,
          timeoutMs: 2000,
        },
      ),
    ).toThrow("ETIMEDOUT");
    const output = readFileSync(file, "utf8");
    expect(output).toContain("--help printed before hang");
    expect(output).toContain('"status":null');
  }, 15000);

  it("records loader/spawn errors even when no process output exists", () => {
    const file = logPath();
    expect(() =>
      runRuntimeCliProbe(join(dirname(file), "missing-server"), ["--help"], {
        env: process.env,
        logPath: file,
      }),
    ).toThrow("ENOENT");
    expect(readFileSync(file, "utf8")).toContain("ENOENT");
  });
});
