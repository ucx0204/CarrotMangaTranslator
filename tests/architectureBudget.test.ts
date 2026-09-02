import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type DependencyReport = {
  modules: Array<{
    source: string;
    dependencies: Array<{
      coreModule: boolean;
      couldNotResolve: boolean;
      dependencyTypes: string[];
      resolved: string;
    }>;
  }>;
};

type ArchitectureBudgetModule = {
  evaluateArchitectureBudget: (report: DependencyReport) => {
    notices: string[];
    violations: string[];
  };
};

const require = createRequire(import.meta.url);
const { evaluateArchitectureBudget } =
  require("../scripts/check-architecture-budget.cjs") as ArchitectureBudgetModule;

describe("architecture dependency budget", () => {
  it("allows explicit public primitives to gain consumers", () => {
    const primitive = "src/renderer/src/components/ui/Button.tsx";
    const report = reportWithConsumers(primitive, 80);
    const primitiveViolations = evaluateArchitectureBudget(
      report,
    ).violations.filter((violation) => violation.startsWith(`${primitive}:`));

    expect(primitiveViolations).toEqual([]);
  });

  it("retains the default fan-in ceiling for ordinary modules", () => {
    const ordinaryModule = "src/renderer/src/features/example/sharedThing.ts";
    const report = reportWithConsumers(ordinaryModule, 26);

    expect(evaluateArchitectureBudget(report).violations).toContain(
      `${ordinaryModule}: runtimeImportedBy 26 exceeds budget 25`,
    );
  });
});

function reportWithConsumers(
  dependencySource: string,
  consumerCount: number,
): DependencyReport {
  return {
    modules: [
      { source: dependencySource, dependencies: [] },
      ...Array.from({ length: consumerCount }, (_, index) => ({
        source: `src/renderer/src/features/example/consumer-${index}.ts`,
        dependencies: [
          {
            coreModule: false,
            couldNotResolve: false,
            dependencyTypes: ["local"],
            resolved: dependencySource,
          },
        ],
      })),
    ],
  };
}
