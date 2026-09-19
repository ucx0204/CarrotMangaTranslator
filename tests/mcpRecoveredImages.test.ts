import { readFile, readdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";

async function preparedRecovery() {
  const f = await retentionFixture();
  await f.paint();
  const before = (await f.snapshot()).pages[0];
  if (!before.inpaintedImagePath) throw new Error("Missing first working image");
  const firstBytes = await readFile(before.inpaintedImagePath);
  const previousIds = new Set((await f.list()).items.map(item => item.id));
  await f.paint({ kind: "paint", geometry: { kind: "rectangle", start: { x: 10, y: 10 }, end: { x: 20, y: 20 } }, protectedAreas: [], color: "#aabbcc" });
  const id = (await f.list()).items.find(item => !previousIds.has(item.id))?.id;
  if (!id) throw new Error("Missing second image history");
  await f.restart();
  await f.recover(id, "undo");
  const page = (await f.snapshot()).pages[0];
  if (!page.inpaintedImagePath) throw new Error("Missing restored working image");
  expect(page.inpaintedImagePath).toContain(".mcp-recovered-");
  return { ...f, id, firstBytes, restored: page.inpaintedImagePath,
    paths: [page.inpaintedImagePath, page.inpaintMaskPath].filter((path): path is string => Boolean(path)) };
}

it("does not accumulate recovered image bytes when a retained change is repeatedly toggled", async () => {
  const f = await preparedRecovery();
  try {
    expect(await readFile(f.restored)).toEqual(f.firstBytes);
    let previous = f.restored;
    for (const direction of ["redo", "undo", "redo", "undo"] as const) {
      await f.recover(f.id, direction);
      const page = (await f.snapshot()).pages[0];
      if (!page.inpaintedImagePath) throw new Error("Missing current image");
      await expect(access(previous)).rejects.toMatchObject({ code: "ENOENT" });
      previous = page.inpaintedImagePath;
      await access(previous);
    }
    expect(await readFile(previous)).toEqual(f.firstBytes);
    expect((await readdir(dirname(f.chapterPath))).filter(name => name.startsWith(".mcp-recovered-"))).toHaveLength(1);
  } finally { await f.close(); }
});

it("keeps files while native artifact history leases use them and collects only the released candidates", async () => {
  const f = await preparedRecovery();
  const { retainLibraryArtifacts } = await import("../src/main/libraryStore/libraryArtifactRetention");
  const { removeUnreferencedInpaintedArtifacts, removeUnreferencedInpaintMaskArtifacts } = await import("../src/main/libraryStore/inpaintedArtifacts");
  const release = retainLibraryArtifacts(f.paths);
  try {
    await f.recover(f.id, "redo");
    for (const path of f.paths) await access(path);
    release();
    const pages = (await f.snapshot()).pages;
    await removeUnreferencedInpaintedArtifacts(dirname(f.chapterPath), f.paths, pages);
    await removeUnreferencedInpaintMaskArtifacts(dirname(f.chapterPath), f.paths, pages);
    for (const path of f.paths) await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await access(pages[0].imagePath);
    await access(pages[0].inpaintedImagePath!);
  } finally { release(); await f.close(); }
});

it("does not retire an entire candidate directory containing an unrelated file", async () => {
  const f = await preparedRecovery();
  try {
    const extra = join(dirname(f.restored), "keep-user-note.txt");
    await writeFile(extra, "not an image owned by this recovery");
    await f.recover(f.id, "redo");
    expect(await readFile(extra, "utf8")).toBe("not an image owned by this recovery");
    await expect(access(f.restored)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.close(); }
});

for (const point of ["after-retire-step", "after-commit-point"] as const) {
  it(`recovers page, action receipt and old working images consistently through ${point}`, async () => {
    const f = await preparedRecovery();
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    const { recoverLibraryTransactions } = await import("../src/main/libraryStore/libraryTransactionRecovery");
    let reset = () => {};
    try {
      const input = await f.actionInput(f.id);
      reset = tx.setLibraryTransactionCrashInjectorForTests(position => {
        if (position === point) throw new tx.SimulatedLibraryTransactionCrash(position);
      });
      const attempt = f.recover(f.id, "redo", input);
      if (point === "after-commit-point") await attempt;
      else await expect(attempt).rejects.toThrow();
      reset();
      await recoverLibraryTransactions();
      await f.restart();
      if (point === "after-commit-point") {
        await expect(access(f.restored)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await f.recover(f.id, "redo", input)).historical).toBe(true);
      } else {
        expect(await readFile(f.restored)).toEqual(f.firstBytes);
        expect((await f.snapshot()).pages[0].inpaintedImagePath).toBe(f.restored);
        await f.recover(f.id, "redo", input);
      }
    } finally { reset(); await f.close(); }
  });
}
