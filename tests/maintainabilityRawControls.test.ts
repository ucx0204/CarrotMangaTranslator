import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { countRawControls, countCssPolicyLiterals, hasNativeSelectTag } =
  require("../scripts/check-maintainability-policy.cjs") as {
    hasNativeSelectTag(path: string, source: string): boolean;
    countRawControls(source: string): Record<string, number>;
    countCssPolicyLiterals(source: string): { numericZIndexes: number };
  };

it("counts real JSX controls without treating comments and string examples as controls", () => {
  expect(
    countRawControls(`
    /** Example: <label><input type="number" /></label> */
    const example = "<button>example</button>";
    const view = <><button>Save</button><input/><textarea /><select /><Input /></>;
  `),
  ).toEqual({ button: 1, input: 1, textarea: 1, select: 1 });
});

it("does not count stacking-token definitions as literal z-index properties", () => {
  expect(
    countCssPolicyLiterals(
      ":root { --menu-z-index: 30; } .menu { z-index: 30; }",
    ).numericZIndexes,
  ).toBe(1);
});

it("rejects all native select tags throughout renderer TS and TSX, including primitives", () => {
  for (const file of [
    "features/Editor.tsx",
    "components/ui/Select.tsx",
    "example.ts",
  ])
    for (const tag of ["select", "option", "optgroup", "datalist"])
      expect(hasNativeSelectTag(`src/renderer/src/${file}`, `<${tag} />`)).toBe(
        true,
      );
  expect(
    hasNativeSelectTag(
      "src/renderer/src/components/ui/Select.tsx",
      "<Select />",
    ),
  ).toBe(false);
  expect(hasNativeSelectTag("src/main/example.ts", "<select />")).toBe(false);
});
