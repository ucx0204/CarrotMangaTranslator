import { afterEach, expect, it, vi } from "vitest";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_GEMMA_MODEL_REPO,
} from "../src/shared/modelPresets";

afterEach(() => vi.restoreAllMocks());

it("uses an explicitly sanitized environment without restoring inherited Python/pip variables", async () => {
  const { runCommand } =
    await import("../src/main/inpainting/fluxAssets/errors");
  vi.stubEnv("PIP_TARGET", "must-not-leak");
  vi.stubEnv("PYTHONHOME", "must-not-leak");
  try {
    const env = { ...process.env };
    delete env.PIP_TARGET;
    delete env.PYTHONHOME;
    const lines: string[] = [];
    await runCommand(
      process.execPath,
      [
        "-e",
        "console.log(JSON.stringify([process.env.PIP_TARGET,process.env.PYTHONHOME]));",
      ],
      { env, onLine: (line) => lines.push(line) },
    );
    expect(lines).toEqual(["[null,null]"]);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("delivers mixed worker line endings and reports a nonzero exit with its stderr", async () => {
  const { runCommand } =
    await import("../src/main/inpainting/fluxAssets/errors");
  const lines: string[] = [];
  await expect(
    runCommand(
      process.execPath,
      [
        "-e",
        'process.stdout.write("ready\\rstep\\r\\nfinished\\n");process.stderr.write("worker failed\\n");process.exitCode=7;',
      ],
      { onLine: (line) => lines.push(line) },
    ),
  ).rejects.toThrow(/failed \(7\).*worker failed/);
  expect(lines).toEqual(
    expect.arrayContaining(["ready", "step", "finished", "worker failed"]),
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    runCommand(process.execPath, [], { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it.each(["command", "ffmpeg", "enhancement", "preflight"])(
  "contains disconnects from the %s process through shutdown",
  async (kind) => {
    const child = Object.assign(new ChildProcess(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      killed: false,
    });
    const kill = vi.spyOn(child, "kill").mockImplementation(() => {
      child.killed = true;
      child.emit("exit", 1, null);
      child.emit("close", 1, null);
      return true;
    });
    // Native subprocess boundary only; production launch/protocol/cleanup stays real.
    vi.spyOn(require("node:child_process"), "spawn").mockReturnValue(child);
    const modulePaths = {
      command: "../src/main/runtime/transport/shell-command.cjs",
      ffmpeg: "../src/main/runtime/assets/image-source-assets.cjs",
      enhancement:
        "../src/main/runtime/assets/powershell-image-enhancement.cjs",
      preflight: "../src/main/runtime/model/server-preflight.cjs",
    };
    const modulePath = require.resolve(
      modulePaths[kind as keyof typeof modulePaths],
    );
    delete require.cache[modulePath];
    const boundary = require(modulePath);
    const options = {
      imagePath: "input.webp",
      outputDir: tmpdir(),
      workingDir: tmpdir(),
      ffmpegPath: "ffmpeg",
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
      modelSource: "huggingface",
      modelRepo: DEFAULT_GEMMA_MODEL_REPO,
      modelFile: DEFAULT_GEMMA_MODEL_FILE,
    };
    const work: Promise<unknown> =
      kind === "command"
        ? boundary.runCommand({ executable: "worker", args: [] })
        : kind === "ffmpeg"
          ? boundary.convertImageToPngBufferWithFfmpeg("input.webp", options)
          : kind === "enhancement"
            ? boundary.buildEnhancedVariantWithPowerShell(options)
            : boundary.verifyLlamaRuntimePreflight(
                join(tmpdir(), "custom-server", "llama-server.exe"),
                options,
              );
    const result = Promise.allSettled([work]);
    const failure = Object.assign(new Error("read ENOTCONN"), {
      code: "ENOTCONN",
    });
    expect(() => child.stdout.emit("error", failure)).not.toThrow();
    expect((await result)[0]).toMatchObject({ status: "rejected" });
    expect(kill).toHaveBeenCalledOnce();
    expect(() => child.stderr.emit("error", failure)).not.toThrow();
    expect(() => child.emit("error", failure)).not.toThrow();
    expect(kill).toHaveBeenCalledOnce();
    delete require.cache[modulePath];
  },
);
