import { randomUUID } from "node:crypto";
import { open, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import type { PreparedImportPreview } from "../src/shared/importTypes";
import type { McpOperationContext } from "../src/main/application/mcpOperationService";

function preview(paths: string[]): PreparedImportPreview {
  return {
    preview: {
      mode: "single",
      sourceKind: "images",
      suggestedWorkTitle: "Fixture",
      chapters: [
        {
          draftId: randomUUID(),
          title: "Fixture",
          sourceKind: "images",
          pages: paths.map((sourcePath, index) => ({
            name: `page-${index}.png`,
            sourcePath,
            sourceKind: "file",
          })),
        },
      ],
    },
  };
}
function context(): McpOperationContext {
  return {
    id: randomUUID(),
    signal: new AbortController().signal,
    assertAuthorized: () => {},
    progress: () => {},
  };
}

it("captures repeated source bytes once, preserves input objects and detects same-size staged corruption", async () => {
  const f = await libraryImportFixture();
  try {
    const { freezeMcpImport } =
      await import("../src/main/mcp/mcpLibraryImportStaging");
    const input = preview([f.originals[0], f.originals[0]]);
    const before = structuredClone(input);
    const frozen = await freezeMcpImport(input, f.env.root, context());
    expect(input).toEqual(before);
    expect(frozen.sourceBytes).toBe(f.bytes.length);
    expect(
      new Set(frozen.preview.chapters[0].pages.map((page) => page.sourcePath))
        .size,
    ).toBe(1);
    await frozen.verify();
    const path = frozen.preview.chapters[0].pages[0].sourcePath;
    const changed = Buffer.from(await readFile(path));
    changed[changed.length - 1] ^= 1;
    await writeFile(path, changed);
    await expect(frozen.verify()).rejects.toMatchObject({
      code: "revision_conflict",
    });
    await frozen.cleanup();
    await frozen.cleanup();
    expect(await readFile(f.originals[0])).toEqual(f.bytes);
  } finally {
    await f.close();
  }
});

it.each(["empty", "oversize", "symlink"] as const)(
  "rejects %s source files without retaining copied input",
  async (kind) => {
    const f = await libraryImportFixture();
    try {
      const { freezeMcpImport } =
        await import("../src/main/mcp/mcpLibraryImportStaging");
      const path = join(f.env.root, `boundary-${kind}.png`);
      if (kind === "symlink") await symlink(f.originals[0], path, "file");
      else {
        const file = await open(path, "wx");
        try {
          if (kind === "oversize") await file.truncate(128 * 1024 * 1024 + 1);
        } finally {
          await file.close();
        }
      }
      const cleanup = vi.fn(async () => {});
      await expect(
        freezeMcpImport({ ...preview([path]), cleanup }, f.env.root, context()),
      ).rejects.toThrow();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(
        (await readdir(join(f.env.root, "tmp"))).filter((name) =>
          name.startsWith("mcp-import-"),
        ),
      ).toEqual([]);
      expect(await readFile(f.originals[0])).toEqual(f.bytes);
      expect(f.validate).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it.each([0, 501])(
  "rejects %i preview pages before source copying and still releases native preparation",
  async (count) => {
    const f = await libraryImportFixture();
    try {
      const { freezeMcpImport } =
        await import("../src/main/mcp/mcpLibraryImportStaging");
      const cleanup = vi.fn(async () => {});
      await expect(
        freezeMcpImport(
          { ...preview(Array<string>(count).fill(f.originals[0])), cleanup },
          f.env.root,
          context(),
        ),
      ).rejects.toMatchObject({ code: "invalid_edit" });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(
        (await readdir(join(f.env.root, "tmp"))).filter((name) =>
          name.startsWith("mcp-import-"),
        ),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it("releases partial capture on cancellation and does not expose a preview from later picker results", async () => {
  const f = await libraryImportFixture();
  try {
    const { freezeMcpImport } =
      await import("../src/main/mcp/mcpLibraryImportStaging");
    const cleanup = vi.fn(async () => {});
    const job = context();
    let checks = 0;
    job.assertAuthorized = () => {
      if (++checks === 3) throw new Error("Cancelled during capture");
    };
    await expect(
      freezeMcpImport({ ...preview(f.originals), cleanup }, f.env.root, job),
    ).rejects.toThrow("Cancelled");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(
      (await readdir(join(f.env.root, "tmp"))).filter((name) =>
        name.startsWith("mcp-import-"),
      ),
    ).toEqual([]);
    expect(await readFile(f.originals[0])).toEqual(f.bytes);
  } finally {
    await f.close();
  }
});
