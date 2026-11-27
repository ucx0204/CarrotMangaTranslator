import { EventEmitter } from "node:events";
import { createQwenFloatInference } from "../src/main/inpainting/qwenFloatInference";
import { beforeAll, vi } from "vitest";
import { onnxRuntimeNode } from "../src/main/runtimeSupport/nativeOnnxRuntime";
import type { Tensor } from "onnxruntime-node";
import { QwenControlCrop } from "../src/main/inpainting/qwenControlCrop";
vi.mock("electron", async () => ({
  nativeImage: (await import("./mcpImageNative.fixture")).imageNativeBoundary,
  utilityProcess: {
    fork: () => {
      const proc = new EventEmitter();
      const infer = createQwenFloatInference();
      return Object.assign(proc, {
        pid: 1,
        postMessage: (input: Parameters<typeof infer>[0]) => {
          void infer(input).then(
            (result) => proc.emit("message", { ok: true, result }),
            (error: Error) =>
              proc.emit("message", { ok: false, error: error.message }),
          );
        },
        kill: () => {
          runtime.stopProcess();
          queueMicrotask(() => proc.emit("exit", 0));
          return true;
        },
      });
    },
  },
}));

const runtime = vi.hoisted(() => ({
  run: vi.fn(),
  stopProcess: vi.fn(),
  printStarted:
    vi.fn<
      (child: {
        stderr: NodeJS.WritableStream;
        exit: (code: number) => void;
      }) => void
    >(),
  disposeTensor: vi.fn(),
  screen: vi.fn(),
}));
vi.mock("node:child_process", async (original) => {
  const child = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const { PassThrough } = await import("node:stream");
  function printSession(exe: string) {
    const stdin = new PassThrough(),
      stdout = new PassThrough(),
      stderr = new PassThrough();
    const process = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      exitCode: null as number | null,
      signalCode: null,
      killed: false,
      pid: undefined,
    });
    function close(code = 0) {
      process.exitCode = code;
      process.emit("exit", code);
      process.emit("close", code);
    }
    runtime.printStarted({ stderr, exit: close });
    stdin.on("data", (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString());
      if (message.type === "shutdown") {
        queueMicrotask(close);
        return;
      }
      void Promise.resolve()
        .then(() =>
          runtime.screen(exe, [
            "-s",
            "-B",
            "-X",
            "utf8",
            message.script,
            ...message.args,
          ]),
        )
        .then(
          (value) =>
            stdout.write(
              JSON.stringify({
                id: message.id,
                ok: true,
                stdout: value?.stdout ?? "",
              }) + "\n",
            ),
          (error) =>
            stdout.write(
              JSON.stringify({
                id: message.id,
                ok: false,
                error: error.message,
              }) + "\n",
            ),
        );
    });
    return process;
  }
  return {
    ...child,
    spawn: (...args: Parameters<typeof child.spawn>) =>
      Array.isArray(args[1]) &&
      args[1].some((arg) => arg.endsWith("qwen-print-session.py"))
        ? printSession(String(args[0]))
        : child.spawn(...args),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: runtime.screen }),
  };
});
beforeAll(() => {
  const session = vi
    .spyOn(onnxRuntimeNode.InferenceSession, "create")
    .mockResolvedValue({
      inputNames: ["image", "mask"],
      outputNames: ["restored"],
      inputMetadata: [],
      outputMetadata: [],
      startProfiling: vi.fn(),
      endProfiling: vi.fn(),
      run: runtime.run,
      release: vi.fn(),
    });
  const nativeDispose = onnxRuntimeNode.Tensor.prototype.dispose;
  const tensor = vi
    .spyOn(onnxRuntimeNode.Tensor.prototype, "dispose")
    .mockImplementation(function (this: Tensor) {
      runtime.disposeTensor();
      nativeDispose.call(this);
    });
  return () => {
    tensor.mockRestore();
    session.mockRestore();
  };
});

export function controlLaunch() {
  return {
    executable: "python",
    script: "qwen-image-control-worker.py",
    comfy: "comfy",
    nodeDirectory: "gguf",
    packageDirectory: "packages",
    models: {
      diffusion: "Q8",
      text: "Q4",
      vae: "vae",
      control: "union",
      prior: "lama",
    },
  };
}

export function makeControlCrop() {
  return new QwenControlCrop(controlLaunch());
}

export { runtime };
