import { execFile } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { normalizeComputeGpuIndex } from "../../shared/gpuSettings";
import {
  selectDirectMlAdapter,
  type DirectMlAdapter,
  type DirectMlDeviceRequest,
} from "./directMlAdapterPolicy";
import { WINDOWS_DIRECT_ML_PROBE } from "./windowsDirectMlProbe";

const probeResultSchema = z.object({
  adapters: z.array(
    z.object({
      deviceId: z.number().int().min(0).max(63),
      name: z.string().min(1),
      luid: z.string().regex(/^[0-9a-f]{16}$/),
      highPerformanceRank: z.number().int().min(0).max(63),
      dedicatedVideoMemory: z.number().nonnegative(),
    }),
  ),
  cudaLuid: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .nullable(),
});

export async function queryWindowsDirectMlAdapter(
  request: DirectMlDeviceRequest,
): Promise<DirectMlAdapter> {
  const cudaIndex =
    request.computeGpuBackend === "cuda"
      ? normalizeComputeGpuIndex(request.computeGpuIndex)
      : undefined;
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `Add-Type -TypeDefinition @'\n${WINDOWS_DIRECT_ML_PROBE}\n'@`,
    "$adapters = @([MgtDirectMlProbe]::Enumerate())",
    `$cudaLuid = ${cudaIndex === undefined ? "$null" : "[MgtDirectMlProbe]::CudaLuid()"}`,
    "@{ adapters = $adapters; cudaLuid = $cudaLuid } | ConvertTo-Json -Depth 4 -Compress",
  ].join("\n");
  const env = { ...process.env };
  if (cudaIndex !== undefined) {
    // OCR's isolated environment omits CUDA_DEVICE_ORDER. Use that same
    // enumeration policy before resolving its visible device zero to a LUID.
    delete env.CUDA_DEVICE_ORDER;
    env.CUDA_VISIBLE_DEVICES = String(cudaIndex);
  }
  const stdout = await runProbe(command, env);
  const result = probeResultSchema.parse(JSON.parse(stdout.trim()));
  return selectDirectMlAdapter(
    request,
    result.adapters,
    result.cudaLuid ?? undefined,
  );
}

function runProbe(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  const powershell = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return new Promise((resolve, reject) => {
    execFile(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
      { env, windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}
