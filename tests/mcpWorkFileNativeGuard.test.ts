import { expect, it, vi } from "vitest";
import { workFileFixture } from "./mcpWorkFileImport.fixture";

it("rejects guarded existing-work replacement before opening the package or changing any chapters", async () => {
  const f = await workFileFixture();
  try {
    const { importWorkShare } =
      await import("../src/main/library/libraryShareFacade");
    const { openSharePackageSession } =
      await import("../src/main/libraryStore/sharePackage");
    const before = await f.library.listLibrary();
    const source = await f.library.openChapter("chapter");
    const openPackage = vi.fn(openSharePackageSession);
    const stage = vi.fn(async () => {});
    await expect(
      importWorkShare(
        {
          packagePath: f.packagePath,
          target: { mode: "existing", workId: "work" },
          entries: [
            {
              source: "package",
              packageChapterId: "chapter",
              title: "Must not replace existing chapters",
            },
          ],
        },
        undefined,
        { assertCanCommit: () => {}, stage },
        { openPackage },
      ),
    ).rejects.toThrow(
      "Guarded work-file publication currently creates a new work only.",
    );
    expect(openPackage).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    expect(await f.library.listLibrary()).toEqual(before);
    expect(await f.library.openChapter("chapter")).toEqual(source);
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    await f.close();
  }
});
