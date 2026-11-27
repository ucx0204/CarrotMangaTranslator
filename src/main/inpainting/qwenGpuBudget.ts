import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { loadRuntimeModuleFromDirectory } from "../runtimeModuleLoader";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { queryWindowsCudaLuid } from "../runtimeSupport/windowsDirectMlAdapter";

const execute = promisify(execFile);
const absoluteLimitMiB = 11 * 1024;
const launchHeadroomMiB = 5000;
const stopHeadroomMiB = 768;

export type QwenGpuStatus = "ready" | "memory" | "inference" | "telemetry";

export class QwenGpuBudget {
  private readonly pythonProcesses = new Map<number, boolean>();
  private adapterLuid?: string;

  constructor(
    private readonly gpuUuid: string,
    private readonly koffiPath?: string,
  ) {}

  private command(field: string, signal?: AbortSignal) {
    return execute(
      "nvidia-smi",
      [`--id=${this.gpuUuid}`, field, "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout: 3500, maxBuffer: 1024 * 1024, signal },
    );
  }

  private async boardStatus(
    headroom: number,
    signal?: AbortSignal,
  ): Promise<QwenGpuStatus> {
    const memory = await this.command(
      "--query-gpu=memory.total,memory.used",
      signal,
    );
    const [total, used] = memory.stdout.trim().split(",").map(Number);
    return qwenBoardStatus(total, used, headroom);
  }

  async status(ownPid?: number): Promise<QwenGpuStatus> {
    const [board, peers] = await Promise.all([
      this.boardStatus(ownPid ? stopHeadroomMiB : launchHeadroomMiB),
      this.inferenceStatus(ownPid),
    ]);
    return peers === "inference" ? peers : board;
  }

  async monitor(
    pid: number,
    closed: Promise<unknown>,
    stop: () => void,
  ): Promise<QwenGpuStatus> {
    const watching = new AbortController();
    const { signal } = watching;
    const counter =
      this.koffiPath && openBoardCounter(this.koffiPath, this.gpuUuid);
    const observers = [
      pollStatus(
        async () => {
          const reading = counter && counter.read();
          return reading
            ? qwenBoardStatus(reading.total, reading.used, stopHeadroomMiB)
            : this.boardStatus(stopHeadroomMiB, signal);
        },
        115,
        signal,
      ),
      pollStatus(() => this.inferenceStatus(pid, signal), 550, signal),
    ];
    try {
      const status = await Promise.race([
        closed.then(() => "ready" as const),
        ...observers,
      ]);
      if (status !== "ready") stop();
      return status;
    } catch (error) {
      stop();
      throw error;
    } finally {
      watching.abort();
      await Promise.allSettled(observers);
      if (counter) counter.close();
    }
  }

  private async inferenceStatus(
    ownPid?: number,
    signal?: AbortSignal,
  ): Promise<QwenGpuStatus> {
    const { stdout } = await this.command(
      "--query-compute-apps=pid,process_name,used_gpu_memory",
      signal,
    );
    const { native, python } = inferenceProcesses(stdout, ownPid);
    for (const pid of this.pythonProcesses.keys())
      if (!python.has(pid)) this.pythonProcesses.delete(pid);
    for (const [pid, mib] of python) {
      if (!this.pythonProcesses.has(pid)) {
        // Return only a boolean: other applications' command lines stay local
        // to the query and never enter the caller's diagnostics.
        const check = await execute(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; [bool]($p.CommandLine -match '(?i)flux|comfyui[\\\\/]main\\.py')`,
          ],
          { windowsHide: true, timeout: 5500, signal },
        );
        this.pythonProcesses.set(pid, check.stdout.trim() === "True");
      }
      if (this.pythonProcesses.get(pid)) native.set(pid, mib);
    }
    if ([...native.values()].some((mib) => mib > 32)) return "inference";
    const unknown = [...native]
      .filter(([, mib]) => !Number.isFinite(mib))
      .map(([pid]) => pid);
    if (
      unknown.length &&
      (await this.windowsAllocationIsActive(unknown, signal))
    )
      return "inference";
    return "ready";
  }

  private async windowsAllocationIsActive(
    pids: number[],
    signal?: AbortSignal,
  ) {
    this.adapterLuid ??= await queryWindowsCudaLuid(this.gpuUuid);
    const luid = this.adapterLuid;
    const id = `luid_0x${luid.slice(0, 8)}_0x${luid.slice(8)}`;
    const filter = `^pid_(?:${pids.join("|")})_${id}_phys_\\d+$`;
    const query = [
      "$ErrorActionPreference='Stop'",
      "$rows=Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -Property Name,DedicatedUsage",
      `[bool]($rows | Where-Object { $_.Name -match '${filter}' -and $_.DedicatedUsage -gt 33554432 } | Select-Object -First 1)`,
    ].join("\n");
    const result = await execute(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", query],
      { windowsHide: true, timeout: 5500, signal },
    );
    return result.stdout.trim() === "True";
  }

  async wait(
    signal: AbortSignal,
    onChange?: (status: QwenGpuStatus) => void,
  ): Promise<void> {
    return waitForQwenGpu(() => this.status(), signal, onChange);
  }
}

// A persistent NVML handle avoids launching nvidia-smi for every 115ms
// sample. Its v2 used counter also includes the driver's reserved memory.
function openBoardCounter(binding: string, uuid: string) {
  try {
    const koffi = (
      basename(binding) === "koffi.node"
        ? loadRuntimeModuleFromDirectory(dirname(binding), "nativeFfi")
        : require("koffi")
    ) as typeof import("koffi", {
      with: { "resolution-mode": "import" },
    });
    const lib = koffi.load(
      join(process.env.SystemRoot || "C:\\Windows", "System32", "nvml.dll"),
    );
    const init = lib.func("int nvmlInit_v2()");
    const close = lib.func("int nvmlShutdown()");
    const handle = lib.func(
      "int nvmlDeviceGetHandleByUUID(const char*, _Out_ void**)",
    );
    const memory = lib.func("int nvmlDeviceGetMemoryInfo_v2(void*, void*)");
    const device = [null];
    const info = Buffer.alloc(40);
    // nvmlMemory_v2_t: version, alignment, then total/reserved/free/used.
    info.writeUInt32LE((2 << 24) | info.length);
    if (init() !== 0) return;
    try {
      if (handle(uuid, device) === 0) {
        return {
          close,
          read: () =>
            memory(device[0], info) === 0
              ? {
                  total: Number(info.readBigUInt64LE(8)) / 1024 ** 2,
                  used: Number(info.readBigUInt64LE(32)) / 1024 ** 2,
                }
              : undefined,
        };
      }
    } catch (error) {
      close();
      throw error;
    }
    close();
  } catch (error) {
    console.warn(
      "Qwen native memory counter unavailable, using nvidia-smi",
      error,
    );
    return undefined;
  }
}

export function qwenBoardStatus(
  total: number,
  used: number,
  headroom: number,
): QwenGpuStatus {
  if (!(total > 0 && used >= 0 && used <= total))
    throw new Error(
      "Qwen Image 2.1 실행에 필요한 GPU 메모리 사용량을 읽을 수 없습니다.",
    );
  const ceiling = Math.min(absoluteLimitMiB, total - 1024);
  if (ceiling <= launchHeadroomMiB)
    throw new Error(
      "선택한 GPU에는 Qwen Image 2.1을 실행할 메모리와 1GiB의 여유 공간이 부족합니다.",
    );
  return used >= ceiling - headroom ? "memory" : "ready";
}

export async function waitForQwenGpu(
  read: () => Promise<QwenGpuStatus>,
  signal: AbortSignal,
  onChange?: (status: QwenGpuStatus) => void,
) {
  let previous: QwenGpuStatus = "ready";
  let failedProbes = 0;
  for (;;) {
    signal.throwIfAborted();
    let status: QwenGpuStatus;
    try {
      status = await read();
      failedProbes = 0;
    } catch (error) {
      signal.throwIfAborted();
      if (++failedProbes >= 3) throw error;
      status = "telemetry";
    }
    if (status !== previous) onChange?.(status);
    if (status === "ready") return;
    previous = status;
    await delay(1500, undefined, { signal });
  }
}

function inferenceProcesses(listing: string, ownPid?: number) {
  const native = new Map<number, number>(),
    python = new Map<number, number>();
  for (const line of listing.trim().split(/\r?\n/)) {
    const match = /^(\d+),\s*(.+),\s*([^,]+)$/.exec(line.trim());
    if (!match || Number(match[1]) === ownPid) continue;
    const name = match[2].split(/[\\/]/).at(-1) ?? "";
    const pid = Number(match[1]),
      mib = Number(match[3]);
    if (/flux|comfy|^sd-(?:server|cli)(?:\.exe)?$/i.test(name))
      native.set(pid, mib);
    if (/^python(?:w|[\d.]*)?(?:\.exe)?$/i.test(name)) python.set(pid, mib);
  }
  return { native, python };
}

export async function pollStatus(
  read: () => Promise<QwenGpuStatus>,
  interval: number,
  signal: AbortSignal,
) {
  for (;;) {
    signal.throwIfAborted();
    const status = await read();
    if (status !== "ready") return status;
    await delay(interval, undefined, { signal });
  }
}

export function qwenWorkerEnvironment(
  env: NodeJS.ProcessEnv,
  gpuUuid?: string,
) {
  const merged = { ...process.env, ...env };
  if (env.HIP_PATH) {
    for (const key of [
      "CUDA_VISIBLE_DEVICES",
      "HIP_VISIBLE_DEVICES",
      "ROCR_VISIBLE_DEVICES",
      "GPU_DEVICE_ORDINAL",
    ])
      delete merged[key];
  }
  if (gpuUuid) merged.CUDA_VISIBLE_DEVICES = gpuUuid;
  return merged;
}
