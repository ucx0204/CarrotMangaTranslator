import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, rmdir, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { isRecoveredImageArtifact } from "../src/main/libraryStore/recoveredImageArtifacts";
import { removeUnreferencedInpaintedArtifacts, removeUnreferencedInpaintMaskArtifacts } from "../src/main/libraryStore/inpaintedArtifacts";

vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return { ...actual, rmdir: vi.fn(actual.rmdir) };
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "recovered-path-test-"));
  const chapter = join(root, "chapter");
  const directory = join(chapter, `.mcp-recovered-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const image = join(directory, "inpaintedImagePath.png"), mask = join(directory, "inpaintMaskPath.png");
  await writeFile(image, "owned working image");
  await writeFile(mask, "owned working mask");
  return { root, chapter, directory, image, mask, close: () => rm(root, { recursive: true, force: true }) };
}

it("accepts only exact recovery filenames and preserves every current page reference regardless of its field", async () => {
  const f = await fixture();
  try {
    expect(isRecoveredImageArtifact(f.chapter, "inpainted", f.image)).toBe(true);
    expect(isRecoveredImageArtifact(f.chapter, "mask", f.mask)).toBe(true);
    for (const path of [f.directory, f.mask, join(f.directory, "extra.png"), join(f.chapter, ".mcp-recovered-not-a-uuid", "inpaintedImagePath.png"), join(f.root, "outside.png")])
      expect(isRecoveredImageArtifact(f.chapter, "inpainted", path)).toBe(false);
    const pages = [{ imagePath: f.image, inpaintedImagePath: f.mask }];
    await removeUnreferencedInpaintedArtifacts(f.chapter, [f.image, f.image], pages);
    await removeUnreferencedInpaintMaskArtifacts(f.chapter, [f.mask], pages);
    expect(await readFile(f.image, "utf8")).toBe("owned working image");
    expect(await readFile(f.mask, "utf8")).toBe("owned working mask");
    await removeUnreferencedInpaintedArtifacts(f.chapter, [f.image], [], [f.image]);
    await access(f.image);
    const unrelated = join(f.directory, "unrelated.png");
    await writeFile(unrelated, "keep");
    await removeUnreferencedInpaintedArtifacts(f.chapter, [unrelated, f.image], []);
    await removeUnreferencedInpaintMaskArtifacts(f.chapter, [f.mask], []);
    expect(await readFile(unrelated, "utf8")).toBe("keep");
  } finally { await f.close(); }
});

it("refuses a recovery-directory symlink without deleting its external target", async () => {
  const f = await fixture();
  const external = join(f.root, "external");
  const linked = join(f.chapter, `.mcp-recovered-${randomUUID()}`);
  try {
    await mkdir(external);
    const target = join(external, "inpaintedImagePath.png");
    await writeFile(target, "outside the owned recovery directory");
    await symlink(external, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(removeUnreferencedInpaintedArtifacts(f.chapter, [join(linked, "inpaintedImagePath.png")], [])).rejects.toThrow("symlink");
    expect(await readFile(target, "utf8")).toBe("outside the owned recovery directory");
  } finally {
    if (process.platform === "win32") await rmdir(linked);
    else await rm(linked);
    await f.close();
  }
});

it("reports directory cleanup failures and can retry after the image itself was already removed", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  try {
    await rm(f.mask);
    const denied = Object.assign(new Error("directory cleanup denied"), { code: "EACCES" });
    vi.mocked(rmdir).mockRejectedValueOnce(denied);
    await expect(removeUnreferencedInpaintedArtifacts(f.chapter, [f.image], [])).rejects.toBe(denied);
    await expect(access(f.image)).rejects.toMatchObject({ code: "ENOENT" });
    await access(f.directory);
    vi.mocked(rmdir).mockImplementation(actual.rmdir);
    await removeUnreferencedInpaintedArtifacts(f.chapter, [f.image], []);
    await expect(access(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { vi.mocked(rmdir).mockImplementation(actual.rmdir); await f.close(); }
});
