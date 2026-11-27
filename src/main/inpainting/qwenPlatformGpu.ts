import { execFile } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import { detectBestGpuInfo, type DetectedGpuInfo } from "../gpuInfo";
import { queryWindowsGpuMemoryAdapters } from "../runtimeSupport/windowsDirectMlAdapter";
import {
  pollStatus,
  qwenBoardStatus,
  qwenWorkerEnvironment,
  waitForQwenGpu,
  type QwenGpuStatus,
} from "./qwenGpuBudget";

const execute = promisify(execFile);
const mib = 1024 ** 2;
type Reading = { total: number; used: number; peer: boolean };
type Device = { key: string; name: string; matchingBoards: number };
export type QwenNativeBackend = "vulkan" | "rocm" | "metal";

/** sd.cpp prints the exact backend keys it accepts on tab-separated stdout. */
export function qwenNativeDevice(
  output: string,
  backend: QwenNativeBackend,
  index?: number,
  preferredName?: string | null,
): Device {
  const pattern = {
    vulkan: /^vulkan\d+$/i,
    rocm: /^(?:rocm|hip|cuda)\d+$/i,
    metal: /^(?:MTL|metal)\d*$/i,
  }[backend];
  const devices = output
    .trim()
    .split(/\r?\n/)
    .flatMap((line) => {
      const [key, name] = line.trim().split("\t");
      return name && pattern.test(key) ? [{ key, name: name.trim() }] : [];
    });
  const preferred =
    index === undefined && preferredName
      ? devices.find(
          (row) => row.name.toLowerCase() === preferredName.toLowerCase(),
        )
      : undefined;
  const selected = preferred ?? devices[index ?? 0];
  if (!selected)
    throw new Error(
      `Qwen Image 2.1 ${backend} GPU ${index ?? 0}번을 찾지 못했습니다.`,
    );
  return {
    ...selected,
    matchingBoards: devices.filter((row) => row.name === selected.name).length,
  };
}

async function windowsGpuReader(
  { name, matchingBoards }: Device,
  intel: DetectedGpuInfo | null,
) {
  // Identical model names can refer to multiple boards. Guard all matching
  // boards, so a namespace/ordinal mismatch can never hide a busy board.
  const adapters = await queryWindowsGpuMemoryAdapters(name);
  const shared =
    intel?.vendor === "intel" &&
    intel.supportsVulkan &&
    intel.memoryMb === null &&
    intel.name?.toLowerCase() === name.toLowerCase();
  const usage = shared ? "SharedUsage" : "DedicatedUsage";
  const physical = new Set<string>();
  const tag = (luid: string) => `luid_0x${luid.slice(0, 8)}_0x${luid.slice(8)}`;
  const ids = adapters.map((a) => tag(a.luid)).join("|");
  const limits = new Map(
    adapters.map((a) => [
      tag(a.luid),
      (shared ? (a.sharedSystemMemory ?? 0) : a.dedicatedVideoMemory) / mib,
    ]),
  );
  const prefix = [
    "$ErrorActionPreference='Stop'",
    `$ids='(${ids})_phys_\\d+$'`,
    `$board=@(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUAdapterMemory -Property Name,${usage} | Where-Object { $_.Name -match $ids } | Select-Object Name,${usage})`,
    `$alloc=Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUProcessMemory -Property Name,${usage}`,
  ];
  return async (own: number, signal: AbortSignal): Promise<Reading[]> => {
    const command = [
      ...prefix,
      `$pids=@($alloc | ForEach-Object { if ($_.${usage} -gt 33554432 -and $_.Name -match ('^pid_(\\d+)_'+$ids) -and [int]$Matches[1] -ne ${own}) { [int]$Matches[1] } })`,
      "$peer=if($pids.Count){ Get-CimInstance Win32_Process -Filter (($pids | ForEach-Object { 'ProcessId='+$_ }) -join ' OR ') | Where-Object { $_.Name -match 'flux|comfy|^sd-(cli|server)' -or ($_.Name -match '^python' -and $_.CommandLine -match 'flux|comfyui[\\\\/]main\\.py') } | Select-Object -First 1 }",
      "@{ board=$board; peer=[bool]$peer } | ConvertTo-Json -Compress",
    ].join("\n");
    const { stdout } = await execute(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { signal, windowsHide: true, timeout: 8000 },
    );
    const result = JSON.parse(stdout) as {
      board: { Name: string; DedicatedUsage?: number; SharedUsage?: number }[];
      peer: boolean;
    };
    const samples = [...limits].flatMap(([id, total]) => {
      const rows = result.board.filter((row) =>
        row.Name.toLowerCase().startsWith(id + "_phys_"),
      );
      // DXGI can also list a remote-display alias without physical WDDM counters.
      if (!rows.length && !physical.has(id)) return [];
      physical.add(id);
      const used = rows.length
        ? rows.reduce((sum, r) => sum + Number(r[usage]), 0) / mib
        : NaN;
      return [
        {
          total,
          used: shared ? Math.max(used, total - freemem() / mib) : used,
          peer: result.peer,
        },
      ];
    });
    if (samples.length < matchingBoards)
      throw new Error("Qwen GPU의 물리 메모리 카운터가 없습니다.");
    return samples;
  };
}

async function metalGpuReading(
  own: number,
  signal: AbortSignal,
): Promise<Reading[]> {
  const opts = { signal, timeout: 5000, maxBuffer: 8 * mib };
  const [registry, processes] = await Promise.all([
    execute(
      "/usr/sbin/ioreg",
      ["-r", "-c", "IOGPU", "-d", "1", "-w", "0", "-l"],
      opts,
    ),
    execute("/bin/ps", ["-axo", "pid=,pcpu=,command="], opts),
  ]);
  const used =
    /"In use system memory"\s*=\s*(\d+)/i.exec(registry.stdout) ??
    /"Alloc system memory"\s*=\s*(\d+)/i.exec(registry.stdout);
  const peer = processes.stdout.split("\n").some((line) => {
    const match = /^\s*(\d+)\s+([\d.,]+)\s+(.+)$/.exec(line);
    return (
      !!match &&
      Number(match[1]) !== own &&
      Number(match[2].replace(",", ".")) > 0 &&
      /(?:^|[\s/])(?:[^\s/]*flux[^\s/]*|sd-(?:cli|server)|comfyui\/main\.py)(?:\s|$)/i.test(
        match[3],
      )
    );
  });
  return [
    { total: totalmem() / mib, used: used ? Number(used[1]) / mib : NaN, peer },
  ];
}

export async function prepareQwenPlatformGpu(
  executable: string,
  env: NodeJS.ProcessEnv,
  backend: QwenNativeBackend,
  index?: number,
  signal?: AbortSignal,
) {
  const listing = await execute(executable, ["--list-devices"], {
    env: qwenWorkerEnvironment(env),
    signal,
    windowsHide: true,
    timeout: 30000,
  });
  const detected =
    backend === "vulkan" && /\bIntel\b/i.test(listing.stdout)
      ? await detectBestGpuInfo()
      : null;
  const intel = detected?.vendor === "intel" ? detected : null;
  const device = qwenNativeDevice(listing.stdout, backend, index, intel?.name);
  const read =
    backend === "metal"
      ? metalGpuReading
      : await windowsGpuReader(device, intel);
  const status = async (pid: number, watching: AbortSignal) => {
    const samples = await read(pid, watching);
    const board = samples.map((sample) =>
      qwenBoardStatus(sample.total, sample.used, pid ? 1024 : 5000),
    );
    if (samples.some((sample) => sample.peer)) return "inference" as const;
    return board.includes("memory") ? ("memory" as const) : ("ready" as const);
  };
  return {
    device: device.key,
    wait: (active: AbortSignal, change?: (value: QwenGpuStatus) => void) =>
      waitForQwenGpu(() => status(0, active), active, change),
    async monitor(
      pid: number,
      closed: Promise<unknown>,
      stop: () => void,
    ): Promise<QwenGpuStatus> {
      const controller = new AbortController();
      const observer = pollStatus(
        () => status(pid, controller.signal),
        200,
        controller.signal,
      );
      try {
        const result = await Promise.race([
          observer,
          closed.then(() => "ready" as const),
        ]);
        if (result !== "ready") stop();
        return result;
      } catch (error) {
        stop();
        throw error;
      } finally {
        controller.abort();
        await Promise.allSettled([observer]);
      }
    },
  };
}
