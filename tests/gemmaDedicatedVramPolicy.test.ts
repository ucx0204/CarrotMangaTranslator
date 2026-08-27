import { describe, expect, it } from "vitest";
import { meetsGemmaDedicatedVramRequirement } from "../src/shared/gemmaMemoryPolicy";

describe("Gemma dedicated VRAM tiers", () => {
  it.each([
    ["minimum12b", 8 * 1024 - 12],
    ["economy26b", 16 * 1024 - 12],
    ["full31b", 24 * 1024 - 12],
  ] as const)("accepts normal driver reporting variance for %s", (mode, mb) => {
    expect(meetsGemmaDedicatedVramRequirement(mode, mb)).toBe(true);
  });

  it("still rejects a genuinely lower VRAM tier", () => {
    expect(meetsGemmaDedicatedVramRequirement("economy26b", 8 * 1024)).toBe(
      false,
    );
    expect(meetsGemmaDedicatedVramRequirement("full31b", 16 * 1024)).toBe(
      false,
    );
  });

  it("rejects missing telemetry and keeps the 128 MiB boundary exact", () => {
    expect(meetsGemmaDedicatedVramRequirement("minimum12b", Number.NaN)).toBe(
      false,
    );
    expect(meetsGemmaDedicatedVramRequirement("minimum12b", 0)).toBe(false);
    expect(
      meetsGemmaDedicatedVramRequirement("minimum12b", 8 * 1024 - 128),
    ).toBe(true);
    expect(
      meetsGemmaDedicatedVramRequirement("minimum12b", 8 * 1024 - 129),
    ).toBe(false);
  });
});
