// System DXGI/CUDA APIs run in a short-lived, hidden PowerShell process. This
// avoids adding another VC++-dependent native addon to the Electron bootstrap.
// Vtable slots follow the Windows SDK IDXGIFactory6/IDXGIAdapter1 contracts.
export const WINDOWS_DIRECT_ML_PROBE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

public static class MgtDirectMlProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct Luid { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Desc {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Name;
    public uint VendorId, DeviceId, SubSysId, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public Luid Luid;
    public uint Flags;
  }
  public class Adapter {
    public uint deviceId;
    public string name, luid;
    public uint highPerformanceRank;
    public ulong dedicatedVideoMemory;
  }
  [DllImport("dxgi.dll", ExactSpelling = true)]
  static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
  [DllImport("d3d12.dll", ExactSpelling = true)]
  static extern int D3D12CreateDevice(IntPtr adapter, uint level, ref Guid iid, IntPtr device);
  [DllImport("nvcuda.dll", ExactSpelling = true)]
  static extern int cuInit(uint flags);
  [DllImport("nvcuda.dll", ExactSpelling = true)]
  static extern int cuDeviceGet(out int device, int ordinal);
  [DllImport("nvcuda.dll", ExactSpelling = true)]
  static extern int cuDeviceGetLuid([Out] byte[] luid, out uint mask, int device);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int EnumAdapters(IntPtr self, uint index, out IntPtr adapter);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int EnumPreferred(IntPtr self, uint index, uint preference, ref Guid iid, out IntPtr adapter);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int GetDesc(IntPtr self, out Desc desc);

  static T Method<T>(IntPtr instance, int slot) {
    IntPtr address = Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance), slot * IntPtr.Size);
    return (T)(object)Marshal.GetDelegateForFunctionPointer(address, typeof(T));
  }
  static string LuidText(Luid luid) {
    return luid.High.ToString("x8") + luid.Low.ToString("x8");
  }
  static bool IsEnd(int result) {
    if (result == unchecked((int)0x887A0002)) return true;
    Marshal.ThrowExceptionForHR(result);
    return false;
  }
  public static Adapter[] Enumerate() {
    Guid iid = new Guid("c1b6694f-ff09-44a9-b03c-77900a0a1d17");
    IntPtr factory;
    Marshal.ThrowExceptionForHR(CreateDXGIFactory1(ref iid, out factory));
    try {
      var ranks = PreferredRanks(factory);
      var adapters = new List<Adapter>();
      var enumerate = Method<EnumAdapters>(factory, 12);
      for (uint index = 0; index < 64; index++) {
        IntPtr adapter;
        if (IsEnd(enumerate(factory, index, out adapter))) break;
        try {
          Desc desc;
          Marshal.ThrowExceptionForHR(Method<GetDesc>(adapter, 10)(adapter, out desc));
          Guid deviceIid = new Guid("189819f1-1db6-4b57-be54-1821339b85f7");
          if ((desc.Flags & 2) != 0 || D3D12CreateDevice(adapter, 0xb000, ref deviceIid, IntPtr.Zero) < 0) continue;
          string luid = LuidText(desc.Luid);
          adapters.Add(new Adapter {
            deviceId = index, name = desc.Name, luid = luid,
            highPerformanceRank = ranks[luid],
            dedicatedVideoMemory = desc.DedicatedVideoMemory.ToUInt64()
          });
        } finally { Marshal.Release(adapter); }
      }
      return adapters.ToArray();
    } finally { Marshal.Release(factory); }
  }
  static Dictionary<string, uint> PreferredRanks(IntPtr factory) {
    var ranks = new Dictionary<string, uint>();
    var enumerate = Method<EnumPreferred>(factory, 29);
    Guid iid = new Guid("29038f61-3839-4626-91fd-086879011a05");
    for (uint index = 0; index < 64; index++) {
      IntPtr adapter;
      if (IsEnd(enumerate(factory, index, 2, ref iid, out adapter))) break;
      try {
        Desc desc;
        Marshal.ThrowExceptionForHR(Method<GetDesc>(adapter, 10)(adapter, out desc));
        ranks.Add(LuidText(desc.Luid), index);
      } finally { Marshal.Release(adapter); }
    }
    return ranks;
  }
  public static string CudaLuid() {
    int device;
    uint mask;
    byte[] bytes = new byte[8];
    int result = cuInit(0);
    if (result == 0) result = cuDeviceGet(out device, 0);
    else throw new InvalidOperationException("cuInit failed: " + result);
    if (result != 0) throw new InvalidOperationException("cuDeviceGet failed: " + result);
    result = cuDeviceGetLuid(bytes, out mask, device);
    if (result != 0 || mask == 0) throw new InvalidOperationException("cuDeviceGetLuid failed: " + result);
    return LuidText(new Luid { Low = BitConverter.ToUInt32(bytes, 0), High = BitConverter.ToUInt32(bytes, 4) });
  }
}
`;
