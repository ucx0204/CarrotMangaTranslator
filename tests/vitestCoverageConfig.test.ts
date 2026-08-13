import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../vitest.config";

type CoverageThresholds = Record<string, number | Record<string, number>>;

describe("Vitest coverage configuration", () => {
  it("keeps every exact per-file threshold attached to an existing file", () => {
    const resolved = config as {
      test?: { coverage?: { thresholds?: CoverageThresholds } };
    };
    const thresholds = resolved.test?.coverage?.thresholds ?? {};
    const missing = Object.entries(thresholds)
      .filter(
        ([pattern, value]) =>
          typeof value === "object" && !pattern.includes("*"),
      )
      .map(([path]) => path)
      .filter((path) => !existsSync(resolve(path)));

    expect(missing).toEqual([]);
  });
});
