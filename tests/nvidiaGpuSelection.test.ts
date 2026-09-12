import { describe, expect, it } from "vitest";
import { queryNvidiaGpuInfo } from "../src/main/gpuInfo";
import { normalizeNvidiaGpuUuid } from "../src/shared/gpuSettings";

const AMPERE = "GPU-11111111-1111-1111-1111-111111111111";
const BLACKWELL = "GPU-22222222-2222-2222-2222-222222222222";
const AMPERE_ROW = `NVIDIA GeForce RTX 3080 Ti, 12288, 8.6, ${AMPERE}`;
const BLACKWELL_ROW = `NVIDIA GeForce RTX 5070 Ti, 16303, 12.0, ${BLACKWELL}`;

describe("NVIDIA physical-device selection", () => {
  it("keeps UUID and capability attached to the highest-VRAM GPU", async () => {
    const gpu = await queryNvidiaGpuInfo(undefined, async () =>
      [AMPERE_ROW, BLACKWELL_ROW].join("\r\n"),
    );
    expect(gpu).toMatchObject({
      name: "NVIDIA GeForce RTX 5070 Ti",
      memoryMb: 16303,
      computeCapability: 12,
      nvidiaUuid: BLACKWELL,
      rtxGeneration: 50,
    });
  });

  it("preserves the physical identity when enumeration order is reversed", async () => {
    for (const rows of [
      [AMPERE_ROW, BLACKWELL_ROW],
      [BLACKWELL_ROW, AMPERE_ROW],
    ]) {
      const gpu = await queryNvidiaGpuInfo(undefined, async () =>
        rows.join("\n"),
      );
      expect(gpu?.nvidiaUuid).toBe(BLACKWELL);
      expect(gpu?.computeCapability).toBe(12);
    }
  });

  it("queries the explicitly requested nvidia-smi device, including index zero", async () => {
    for (const index of [0, 1]) {
      const calls: string[][] = [];
      const gpu = await queryNvidiaGpuInfo(index, async (file, args) => {
        calls.push([file, ...args]);
        return AMPERE_ROW;
      });
      expect(calls).toEqual([
        [
          "nvidia-smi",
          `--id=${index}`,
          "--query-gpu=name,memory.total,compute_cap,uuid",
          "--format=csv,noheader,nounits",
        ],
      ]);
      expect(gpu?.nvidiaUuid).toBe(AMPERE);
      expect(gpu?.computeCapability).toBe(8.6);
    }
  });

  it("does not replace an invalid explicit index with automatic selection", async () => {
    for (const index of [-1, 1.5, 16, Number.NaN]) {
      let queried = false;
      const gpu = await queryNvidiaGpuInfo(index, async () => {
        queried = true;
        return BLACKWELL_ROW;
      });
      expect(gpu).toBeNull();
      expect(queried).toBe(false);
    }
  });

  it("rejects ambiguous multi-device output for an explicit selection", async () => {
    expect(
      await queryNvidiaGpuInfo(1, async () => `${AMPERE_ROW}\n${BLACKWELL_ROW}`),
    ).toBeNull();
  });

  it("preserves the UUID but not an invented capability on legacy probes", async () => {
    const calls: string[][] = [];
    const gpu = await queryNvidiaGpuInfo(1, async (_file, args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error("compute_cap unsupported");
      return `NVIDIA GeForce RTX 3080 Ti, 12288, ${AMPERE}`;
    });
    expect(calls[1]).toEqual([
      "--id=1",
      "--query-gpu=name,memory.total,uuid",
      "--format=csv,noheader,nounits",
    ]);
    expect(gpu?.nvidiaUuid).toBe(AMPERE);
    expect(gpu?.computeCapability).toBeNull();
  });

  it("does not cache explicit probes across acquisitions", async () => {
    const first = await queryNvidiaGpuInfo(0, async () => AMPERE_ROW);
    const second = await queryNvidiaGpuInfo(0, async () => BLACKWELL_ROW);
    expect(first?.nvidiaUuid).toBe(AMPERE);
    expect(second?.nvidiaUuid).toBe(BLACKWELL);
  });

  it("retains inventory information without accepting a malformed UUID", async () => {
    const gpu = await queryNvidiaGpuInfo(undefined, async () =>
      AMPERE_ROW.replace(AMPERE, "GPU-1111"),
    );
    expect(gpu?.computeCapability).toBe(8.6);
    expect(gpu?.nvidiaUuid).toBeUndefined();
  });

  it("returns no GPU for empty, malformed, or failed queries", async () => {
    for (const output of ["", "\r\n", "NVIDIA, N/A, 8.6, GPU-invalid"]) {
      expect(await queryNvidiaGpuInfo(undefined, async () => output)).toBeNull();
    }
    expect(
      await queryNvidiaGpuInfo(undefined, async () => {
        throw new Error("nvidia-smi unavailable");
      }),
    ).toBeNull();
  });
});

describe("physical NVIDIA UUID validation", () => {
  it("normalizes full UUIDs and rejects prefixes, lists, and non-string values", () => {
    expect(normalizeNvidiaGpuUuid(`  ${AMPERE.toLowerCase()}  `)).toBe(AMPERE);
    for (const value of [
      undefined,
      null,
      0,
      true,
      "",
      "GPU-1111",
      `${AMPERE},${BLACKWELL}`,
    ]) {
      expect(normalizeNvidiaGpuUuid(value)).toBeUndefined();
    }
  });
});
