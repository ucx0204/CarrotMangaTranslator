import { describe, expect, it } from "vitest";
import * as shareImportTrash from "../src/main/libraryStore/shareImportTrash";

describe("legacy share import trash compatibility module", () => {
  it("exposes startup recovery only and no production trash mutation API", () => {
    expect(shareImportTrash.recoverLegacyShareImportTrash).toBeTypeOf(
      "function",
    );
    expect(Object.keys(shareImportTrash).sort()).toEqual([
      "recoverLegacyShareImportTrash",
    ]);
  });
});
