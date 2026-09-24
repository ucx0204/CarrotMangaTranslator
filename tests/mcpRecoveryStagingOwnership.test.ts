import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";

it.each(["identity", "target", "extra-field", "missing"])(
  "rejects %s owner metadata even when content still matches",
  async (kind) => {
    const f = await libraryImportFixture();
    try {
      const native =
        await import("../src/main/libraryStore/libraryTransaction");
      const { withLibraryMutation } = await import("../src/main/library/lock");
      const { captureStagedDeletionTree } =
        await import("../src/main/mcp/mcpChapterDeletionFiles");
      await withLibraryMutation(() =>
        native.runLibraryTransaction("staging-owner-test", async (tx) => {
          const staged = await tx.createPublishedDirectory(
            join(f.env.libraryDir, "owner-test"),
          );
          await writeFile(join(staged.stagingDirectory, "work.json"), "{}");
          const owner = await staged.verifyOwnership();
          const path = join(owner.directory, owner.marker);
          const original = await readFile(path);
          const data = JSON.parse(original.toString());
          if (kind === "identity") data.transactionId = "another-transaction";
          if (kind === "target") data.target = "works/another";
          if (kind === "extra-field") data.ignored = true;
          if (kind === "missing") await unlink(path);
          else await writeFile(path, JSON.stringify(data));
          try {
            await expect(
              captureStagedDeletionTree(staged, () => {}, "work.json"),
            ).rejects.toThrow();
          } finally {
            await writeFile(path, original);
          }
          const tree = await captureStagedDeletionTree(
            staged,
            () => {},
            "work.json",
          );
          expect(tree.files.map((entry) => entry.path)).toEqual(["work.json"]);
        }),
      );
    } finally {
      await f.close();
    }
  },
);

it("keeps nested marker-named data and refuses expired or mismatched native handles", async () => {
  const f = await libraryImportFixture();
  try {
    const native = await import("../src/main/libraryStore/libraryTransaction");
    const { withLibraryMutation } = await import("../src/main/library/lock");
    const { captureStagedDeletionTree } =
      await import("../src/main/mcp/mcpChapterDeletionFiles");
    const staged = await withLibraryMutation(() =>
      native.runLibraryTransaction("nested-marker-data", async (tx) => {
        const value = await tx.createPublishedDirectory(
          join(f.env.libraryDir, "nested-owner-test"),
        );
        await writeFile(join(value.stagingDirectory, "work.json"), "{}");
        await mkdir(join(value.stagingDirectory, "nested"));
        await writeFile(
          join(
            value.stagingDirectory,
            "nested",
            native.TRANSACTION_OWNER_MARKER,
          ),
          "user-data",
        );
        const tree = await captureStagedDeletionTree(
          value,
          () => {},
          "work.json",
        );
        expect(tree.files.map((entry) => entry.path)).toContain(
          `nested/${native.TRANSACTION_OWNER_MARKER}`,
        );
        await expect(
          captureStagedDeletionTree(
            { ...value, stagingDirectory: f.env.libraryDir },
            () => {},
            "work.json",
          ),
        ).rejects.toThrow(/ownership/);
        return value;
      }),
    );
    await expect(staged.verifyOwnership()).rejects.toThrow();
    expect(
      await readFile(
        join(staged.finalDirectory, "nested", native.TRANSACTION_OWNER_MARKER),
        "utf8",
      ),
    ).toBe("user-data");
  } finally {
    await f.close();
  }
});

it.each(["file", "directory", "case-alias"])(
  "preserves a reserved-root %s and rejects it as recovery source",
  async (kind) => {
    const f = await libraryImportFixture();
    try {
      const native =
        await import("../src/main/libraryStore/libraryTransaction");
      const files = await import("../src/main/mcp/mcpChapterDeletionFiles");
      const directory = join(f.env.libraryDir, "reserved-root-source");
      await mkdir(directory);
      await writeFile(join(directory, "work.json"), "{}");
      const tree = await files.captureChapterDeletionTree(
        directory,
        () => {},
        "work.json",
      );
      const name =
        kind === "case-alias"
          ? native.TRANSACTION_OWNER_MARKER.toUpperCase()
          : native.TRANSACTION_OWNER_MARKER;
      const path = join(directory, name);
      if (kind === "directory") await mkdir(path);
      else await writeFile(path, "private source data");
      await expect(
        files.captureChapterDeletionTree(directory, () => {}, "work.json"),
      ).rejects.toThrow(/reserved/);
      expect(() =>
        files.validateChapterDeletionTree(
          {
            ...tree,
            files: [...tree.files, { ...tree.files[0], path: name }],
          },
          "work.json",
        ),
      ).toThrow(/reserved/);
      if (kind !== "directory")
        expect(await readFile(path, "utf8")).toBe("private source data");
    } finally {
      await f.close();
    }
  },
);

it("rechecks native ownership after file capture rather than trusting an earlier successful probe", async () => {
  const f = await libraryImportFixture();
  try {
    const { writeFileSync } = await import("node:fs");
    const native = await import("../src/main/libraryStore/libraryTransaction");
    const { withLibraryMutation } = await import("../src/main/library/lock");
    const { captureStagedDeletionTree } =
      await import("../src/main/mcp/mcpChapterDeletionFiles");
    await withLibraryMutation(() =>
      native.runLibraryTransaction("late-owner-change", async (tx) => {
        const staged = await tx.createPublishedDirectory(
          join(f.env.libraryDir, "late-owner-source"),
        );
        await writeFile(join(staged.stagingDirectory, "work.json"), "{}");
        const owned = await staged.verifyOwnership();
        const path = join(owned.directory, owned.marker);
        const original = await readFile(path);
        let calls = 0;
        const guard = () => {
          if (++calls === 3) writeFileSync(path, "{}");
        };
        try {
          await expect(
            captureStagedDeletionTree(staged, guard, "work.json"),
          ).rejects.toThrow();
          expect(calls).toBeGreaterThanOrEqual(3);
        } finally {
          await writeFile(path, original);
        }
        expect(
          (await captureStagedDeletionTree(staged, () => {}, "work.json"))
            .files,
        ).toHaveLength(1);
      }),
    );
  } finally {
    await f.close();
  }
});
