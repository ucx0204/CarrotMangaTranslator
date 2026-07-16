import { describe, expect, it } from "vitest";
import { createWarningCollector } from "../src/main/pipeline/warningCollector";
import { MAX_WARNINGS } from "../src/shared/ipcContractCore";

describe("translation warning collector", () => {
  it("caps warnings at the IPC limit and summarizes omitted details", () => {
    const collector = createWarningCollector();

    collector.add(
      ...Array.from(
        { length: MAX_WARNINGS + 100 },
        (_, index) => `warning-${index}`,
      ),
    );

    expect(collector.warnings).toHaveLength(MAX_WARNINGS);
    expect(collector.warnings.at(-1)).toContain("101");
  });
});
