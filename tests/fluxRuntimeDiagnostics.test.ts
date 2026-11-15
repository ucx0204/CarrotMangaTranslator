import { describe, expect, it, vi } from "vitest";
import {
  buildFluxRuntimeExitError,
  formatFluxRuntimeDetail,
} from "../src/main/inpainting/fluxWorkerErrors";
import { FluxWorker } from "../src/main/inpainting/fluxWorker";

const nativeStack = Array.from(
  { length: 30 },
  (_, index) => `0x00007FF6FE${index}, mgt-flux-klein.exe + 0x1ED86A byte(s)`,
).join("\n");
const request = {
  input: "unused-input.png",
  mask: "unused-mask.png",
  output: "unused-output.png",
  steps: 4,
  strength: 1,
  maxPixels: 1024,
  maskPadding: 0,
};

describe("Flux native failure diagnostics", () => {
  it("reports Vulkan failures without CUDA advice or CPU substitution", () => {
    const error = buildFluxRuntimeExitError(
      3,
      "requested FLUX device Vulkan0 is unavailable; CPU fallback is disabled",
      "vulkan-native",
    );
    expect(error.message).toContain("Vulkan");
    expect(error.message).toContain("exitCode=3");
    expect(error.message).not.toContain("CUDA");
  });
  it.each(["rocm-native", "python-rocm"] as const)(
    "does not infer driver failure from ordinary %s initialization output",
    (backend) => {
      const error = buildFluxRuntimeExitError(
        3,
        "ROCm initialization complete: device 0 ready\nfatal: failed to read model tensor",
        backend,
      );
      expect(error.message).toContain("failed to read model tensor");
      expect(error.message).toContain("exitCode=3");
      expect(error.message).not.toContain("AMD GPU를 사용할 수 없습니다");
      expect(error.message).not.toContain("드라이버");
    },
  );

  it("keeps exit status for specific loader errors and unknown exits", () => {
    expect(
      buildFluxRuntimeExitError(
        1,
        "ModuleNotFoundError: No module named stable_diffusion_cpp",
        "python-rocm",
      ).message,
    ).toContain("exitCode=1");
    expect(
      buildFluxRuntimeExitError(null, "", "rocm-native").message,
    ).toContain("exitCode=unknown");
  });

  it("keeps the cause and stack tail while bounding and sanitizing the error", () => {
    const stderr =
      "ROCm initialized\n".repeat(200) +
      "HIP error: out of memory\n" +
      "C:\\Users\\alice\\.cargo\\registry\\src\\crate\\lib.rs:42\n" +
      nativeStack;
    const message = buildFluxRuntimeExitError(3, stderr, "rocm-native").message;
    expect(message).toContain("HIP error: out of memory");
    expect(message).toContain("<rust-crate-source>:42");
    expect(message).not.toContain("alice");
    expect(message).toContain("0x00007FF6FE29");
    expect(message.length).toBeLessThan(1800);
  });

  it("retains both ends of unrecognized diagnostics and leaves short text intact", () => {
    expect(formatFluxRuntimeDetail(" \n")).toBe("");
    expect(formatFluxRuntimeDetail("native status 7\ncontext")).toBe(
      "detail=native status 7 context",
    );
    const text = "NATIVE_CAUSE\n" + "frame\n".repeat(500) + "STACK_END";
    expect(formatFluxRuntimeDetail(text)).toContain("NATIVE_CAUSE");
    expect(formatFluxRuntimeDetail(text)).toContain("STACK_END");
  });

  it.each(["one-large-write", "many-writes"] as const)(
    "preserves split native errors through a real worker crash (%s)",
    async (mode) => {
      const { worker, warn } = createWorker(crashScript(mode));
      try {
        const error = await worker
          .inpaint(request)
          .catch((cause: Error) => cause);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("HIP error: out of memory");
        expect((error as Error).message).toContain("exitCode=3");
        expect((error as Error).message).toContain("STACK_END");
        expect((error as Error).message.length).toBeLessThan(1800);
        expect(warn).toHaveBeenCalledWith(
          "Flux runtime exited",
          expect.objectContaining({
            backend: "rocm-native",
            exitCode: 3,
            error: expect.stringContaining("HIP error: out of memory"),
          }),
        );
        expect(worker.isHealthy()).toBe(false);
      } finally {
        await worker.dispose();
      }
    },
  );

  it.each([true, false])(
    "does not reuse an earlier completed request's failure context (ok=%s)",
    async (ok) => {
      const { worker } = createWorker(`
        let count = 0;
        require('node:readline').createInterface({input: process.stdin}).on('line', line => {
          const request = JSON.parse(line);
          if (request.type === 'shutdown') return process.exit(0);
          if (++count === 1) {
            process.stderr.write('fatal: FIRST_REQUEST_FAILURE\\n', () => {
              console.log(JSON.stringify({id: request.id, ok: ${ok}, error: 'first request failed'}));
            });
          } else {
            process.stderr.write('HIP error: SECOND_REQUEST_FAILURE\\n' + 'frame\\n'.repeat(10000) + 'STACK_END', () => process.exit(3));
          }
        });
      `);
      try {
        if (ok) await worker.inpaint(request);
        else
          await expect(worker.inpaint(request)).rejects.toThrow(
            "first request failed",
          );
        const error = await worker
          .inpaint(request)
          .catch((cause: Error) => cause);
        expect((error as Error).message).toContain("SECOND_REQUEST_FAILURE");
        expect((error as Error).message).not.toContain("FIRST_REQUEST_FAILURE");
      } finally {
        await worker.dispose();
      }
    },
  );
});

function createWorker(script: string) {
  const warn = vi.fn();
  const worker = new FluxWorker(
    {
      backend: "rocm-native",
      executable: process.execPath,
      args: ["-e", script],
      runtimePath: process.execPath,
      label: "native diagnostic fixture",
    },
    { diagnostics: { info: vi.fn(), warn }, requestTimeoutMs: 10_000 },
  );
  return { worker, warn };
}

function crashScript(mode: "one-large-write" | "many-writes"): string {
  return `
    require('node:readline').createInterface({input: process.stdin}).once('line', () => {
      process.stderr.write('HIP er', () => setTimeout(() => {
        process.stderr.write('ror: out of memory\\n', () => {
          let remaining = ${mode === "many-writes" ? 100 : 1};
          const frames = '0x00007FF6FE123, mgt-flux-klein.exe + 0x1ED86A byte(s)\\n'.repeat(1000);
          const write = () => {
            if (remaining-- === 0) return process.stderr.write('STACK_END', () => process.exit(3));
            process.stderr.write(frames, () => setTimeout(write, 2));
          };
          write();
        });
      }, 10));
    });
  `;
}
