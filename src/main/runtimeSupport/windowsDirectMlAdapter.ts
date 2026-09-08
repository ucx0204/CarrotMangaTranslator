import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { normalizeComputeGpuIndex } from "../../shared/gpuSettings";
import {
  selectDirectMlAdapter,
  type DirectMlAdapter,
  type DirectMlDeviceRequest,
} from "./directMlAdapterPolicy";
import { WINDOWS_DIRECT_ML_PROBE } from "./windowsDirectMlProbe";
import { safeCleanup } from "../safeCleanup";

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

async function runProbe(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const directory = await createProbeTempDirectory(env);
  // Windows environment keys are case-insensitive. Remove aliases before
  // setting these, otherwise child_process may select an inherited stale key.
  for (const key of Object.keys(env)) {
    if (["TEMP", "TMP"].includes(key.toUpperCase())) delete env[key];
  }
  env.TEMP = directory;
  env.TMP = directory;
  try {
    return await executeProbe(command, env);
  } finally {
    await safeCleanup("remove DirectML probe compiler files", () =>
      rm(directory, { recursive: true, force: true }),
    );
  }
}

async function createProbeTempDirectory(
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const candidates = [
    tmpdir(),
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Temp") : undefined,
    join(homedir(), "AppData", "Local", "Temp"),
  ].filter((directory): directory is string => Boolean(directory));
  const failures: unknown[] = [];
  for (const directory of new Set(candidates)) {
    try {
      await mkdir(directory, { recursive: true });
      return await mkdtemp(join(directory, "mgt-directml-probe-"));
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(
    failures,
    "GPU 정보를 확인할 임시 폴더를 만들지 못했습니다.",
  );
}

function executeProbe(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
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
