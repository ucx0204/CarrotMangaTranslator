import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pathState = vi.hoisted(() => ({
  libraryDir: "C:\\first-library",
}));

vi.mock("../src/main/appPaths", () => ({
  getAppPaths: () => ({ libraryDir: pathState.libraryDir }),
}));

import {
  getChapterFilePath,
  getLibraryRoot,
  getWorkFilePath,
  getWorksRoot,
} from "../src/main/libraryStore/libraryPaths";

describe("library paths", () => {
  beforeEach(() => {
    pathState.libraryDir = "C:\\first-library";
  });

  it("resolves paths at call time instead of freezing import order", () => {
    expect(getLibraryRoot()).toBe("C:\\first-library");
    expect(getWorksRoot()).toBe(join("C:\\first-library", "works"));

    pathState.libraryDir = "D:\\configured-library";

    expect(getLibraryRoot()).toBe("D:\\configured-library");
    expect(getWorksRoot()).toBe(join("D:\\configured-library", "works"));
  });

  it("builds validated work and chapter paths from the current root", () => {
    pathState.libraryDir = "D:\\configured-library";
    const workId = "11111111-1111-4111-8111-111111111111";
    const chapterId = "22222222-2222-4222-8222-222222222222";

    expect(getWorkFilePath(workId)).toBe(
      join("D:\\configured-library", "works", workId, "work.json"),
    );
    expect(getChapterFilePath(workId, chapterId)).toBe(
      join(
        "D:\\configured-library",
        "works",
        workId,
        "chapters",
        chapterId,
        "chapter.json",
      ),
    );
  });

  it("rejects path-shaped storage IDs", () => {
    expect(() => getWorkFilePath("../outside")).toThrow(/ID/);
    expect(() =>
      getChapterFilePath(
        "11111111-1111-4111-8111-111111111111",
        "chapter/../../outside",
      ),
    ).toThrow(/ID/);
  });
});
