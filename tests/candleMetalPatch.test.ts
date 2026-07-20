import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const { BROKEN_OFFSET, FIXED_OFFSET, patchCandleMetalSource } =
  require("../scripts/patch-candle-metal-qmatmul.cjs") as {
    BROKEN_OFFSET: string;
    FIXED_OFFSET: string;
    patchCandleMetalSource: (
      sourcePath: string,
    ) => "applied" | "already-applied";
  };

describe("Candle quantized Metal source patch", () => {
  it("replaces the temporary layout offset and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgt-candle-metal-patch-"));
    const sourcePath = join(dir, "metal.rs");
    try {
      writeFileSync(sourcePath, `before\n${BROKEN_OFFSET}\nafter\n`);

      expect(patchCandleMetalSource(sourcePath)).toBe("applied");
      expect(readFileSync(sourcePath, "utf8")).toContain(FIXED_OFFSET);
      expect(patchCandleMetalSource(sourcePath)).toBe("already-applied");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown Candle implementation", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgt-candle-metal-patch-"));
    const sourcePath = join(dir, "metal.rs");
    try {
      writeFileSync(sourcePath, "unrelated source\n");
      expect(() => patchCandleMetalSource(sourcePath)).toThrow(
        /Unexpected Candle quantized Metal offset implementation/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
