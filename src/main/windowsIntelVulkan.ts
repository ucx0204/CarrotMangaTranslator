import { execFile } from "node:child_process";
import type { DetectedGpuInfo } from "./gpuInfoTypes";

// Run the installed 64-bit Vulkan loader out of process. A broken display
// driver must not crash or indefinitely block the Electron main process.
const probe = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class VulkanDisplay {
  [StructLayout(LayoutKind.Sequential)]
  struct InstanceInfo {
    public uint type; public IntPtr next; public uint flags; public IntPtr app;
    public uint layers; public IntPtr layerNames; public uint extensions; public IntPtr extensionNames;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi, Size=4096)]
  struct Properties {
    public uint api, driver, vendor, device, kind;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string name;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Heap { public ulong bytes; public uint flags; }
  [StructLayout(LayoutKind.Sequential)]
  struct Memory {
    public uint typeCount;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst=64)] public uint[] types;
    public uint heapCount;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst=16)] public Heap[] heaps;
  }
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  [DllImport("vulkan-1.dll")] static extern int vkCreateInstance(ref InstanceInfo info, IntPtr allocator, out IntPtr instance);
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  [DllImport("vulkan-1.dll")] static extern void vkDestroyInstance(IntPtr instance, IntPtr allocator);
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  [DllImport("vulkan-1.dll")] static extern int vkEnumeratePhysicalDevices(IntPtr instance, ref uint count, [Out] IntPtr[] devices);
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  [DllImport("vulkan-1.dll")] static extern void vkGetPhysicalDeviceProperties(IntPtr device, out Properties properties);
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  [DllImport("vulkan-1.dll")] static extern void vkGetPhysicalDeviceMemoryProperties(IntPtr device, out Memory memory);
  public static string[] List() {
    var rows = new List<string>();
    var info = new InstanceInfo { type = 1 };
    IntPtr instance;
    if (vkCreateInstance(ref info, IntPtr.Zero, out instance) != 0) return rows.ToArray();
    try {
      uint count = 0;
      if (vkEnumeratePhysicalDevices(instance, ref count, null) != 0 || count == 0 || count > 64) return rows.ToArray();
      var devices = new IntPtr[count];
      if (vkEnumeratePhysicalDevices(instance, ref count, devices) != 0) return rows.ToArray();
      for (int i = 0; i < count; ++i) {
        Properties p;
        vkGetPhysicalDeviceProperties(devices[i], out p);
        if (p.api < ((1u << 22) | (2u << 12)) || (p.kind != 1 && p.kind != 2)) continue;
        ulong bytes = 0;
        if (p.kind == 2) {
          Memory m;
          vkGetPhysicalDeviceMemoryProperties(devices[i], out m);
          for (int h = 0; h < m.heapCount; ++h)
            if ((m.heaps[h].flags & 1) != 0) bytes = Math.Max(bytes, m.heaps[h].bytes);
        }
        rows.Add(p.vendor.ToString("X") + "\\t" + (bytes >> 20) + "\\t" + p.name);
      }
    } finally { vkDestroyInstance(instance, IntPtr.Zero); }
    return rows.ToArray();
  }
}`;

export function parseIntelVulkanDevices(
  stdout: string,
): DetectedGpuInfo | null {
  let best: DetectedGpuInfo | null = null;
  for (const row of stdout.split(/\r?\n/)) {
    const [vendor, memory, name] = row.trim().split("\t");
    if (vendor !== "8086" || !name || !/^\d+$/.test(memory)) continue;
    const memoryMb = Number(memory) || null;
    if (best && (best.memoryMb ?? 0) >= (memoryMb ?? 0)) continue;
    best = {
      vendor: "intel",
      name,
      memoryMb,
      rtxGeneration: null,
      computeCapability: null,
      supportsVulkan: true,
    };
  }
  return best;
}

export async function queryIntelVulkanGpu(): Promise<DetectedGpuInfo | null> {
  const command = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${probe}\n'@\n[VulkanDisplay]::List()`;
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: 6000 },
      (error, stdout) =>
        resolve(error ? null : parseIntelVulkanDevices(stdout)),
    );
  });
}
