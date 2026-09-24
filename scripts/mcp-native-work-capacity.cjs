const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdir, rmdir, readFile } = require("node:fs/promises");
const { join } = require("node:path");

/** The enclosing native smoke owns this profile and has restored its original two-chapter work.
 * @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {string} workId
 * @param {(directory: string, restored: () => Promise<void>) => Promise<void>} exercise */
async function checkNativeWorkCapacity(root, app, workId, exercise) {
  assert.equal(app.appPaths.dataRoot, root);
  const library = require(join(root, "out/main/library.js"));
  const { captureChapterDeletionTree } = require(
    join(root, "out/main/mcp/mcpChapterDeletionFiles.js"),
  );
  const base = library.getLibraryRoot();
  const directory = join(base, "works", workId);
  const original = await captureChapterDeletionTree(
    directory,
    () => {},
    "work.json",
  );
  const indexPath = join(base, "index.json");
  const index = await readFile(indexPath);
  const count = 2000 - original.files.length - original.directories.length;
  assert.ok(count > 0);
  const prefix = `mcp-capacity-${randomUUID()}`;
  const additions = Array.from({ length: count }, (_, i) =>
    join(directory, `${prefix}-${i}`),
  );
  for (let offset = 0; offset < additions.length; offset += 50)
    await Promise.all(
      additions.slice(offset, offset + 50).map((path) => mkdir(path)),
    );
  const expected = await captureChapterDeletionTree(
    directory,
    () => {},
    "work.json",
  );
  assert.equal(expected.files.length + expected.directories.length, 2000);
  await exercise(directory, async () => {
    assert.deepEqual(
      await captureChapterDeletionTree(directory, () => {}, "work.json"),
      expected,
    );
    assert.deepEqual(await readFile(indexPath), index);
  });
  // Remove only the known empty fixture directories, after exact recovery; never recursively remove originals.
  for (const path of additions) await rmdir(path);
  assert.deepEqual(
    await captureChapterDeletionTree(directory, () => {}, "work.json"),
    original,
  );
  console.log(
    "PASS native work deletion exact capacity -> 2000 entries -> reconstructed Undo/Redo -> original preservation",
  );
}

module.exports = { checkNativeWorkCapacity };
