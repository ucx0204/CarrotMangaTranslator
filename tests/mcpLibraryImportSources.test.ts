import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import AdmZip from "adm-zip";
import { expect, it } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import { importWebBoundary } from "./mcpLibraryImportWeb.fixture";
import { McpImportPreviewReferenceSchema } from "../src/shared/mcpLibraryImport";

it("reviews a real ZIP in native numeric order and imports only the selected member", async () => {
  const f = await libraryImportFixture();
  try {
    const archive = join(f.env.root, "selected.cbz");
    const zip = new AdmZip();
    zip.addFile("chapter/10.png", await readFile(f.originals[1]));
    zip.addFile("chapter/2.png", f.bytes);
    zip.addFile("notes.txt", Buffer.from("not an image"));
    zip.writeZip(archive);
    f.choose.mockResolvedValueOnce([archive]);
    const done = await f.settle(
      await f.invoke("carrot_choose_import_files", {
        requestId: randomUUID(),
        source: "local",
        kind: "archive",
      }),
    );
    expect(done, JSON.stringify(f.errors)).toMatchObject({
      status: "completed",
    });
    const ref = McpImportPreviewReferenceSchema.parse(
      done.result?.importPreview,
    );
    const review = await f.inspect(ref);
    expect(review.pages.map((page) => page.name)).toEqual([
      "chapter/2.png",
      "chapter/10.png",
    ]);
    const input = await f.command(ref);
    input.chapters[0].pageIds = input.chapters[0].pageIds.slice(0, 1);
    const receipt = await f.create(input);
    const saved = await f.library.openChapter(receipt.chapterIds[0]);
    expect(saved.pages).toHaveLength(1);
    expect(await readFile(saved.pages[0].imagePath)).toEqual(f.bytes);
    expect(zip.toBuffer()).toEqual(await readFile(archive));
  } finally {
    await f.close();
  }
});

it.each(["reversed", "subset"] as const)(
  "preserves explicit %s web selection while keeping native numbered-file semantics",
  async (mode) => {
    let originals: string[] = [];
    const web = importWebBoundary(() => originals);
    const f = await libraryImportFixture({ web });
    originals = f.originals;
    try {
      const job = await f.settle(
        await f.invoke("carrot_scan_import_url", {
          source: "web",
          url: "https://example.com/chapter",
          allowNetwork: true,
          requestId: randomUUID(),
        }),
      );
      expect(job, JSON.stringify(f.errors)).toMatchObject({
        status: "completed",
      });
      const ref = McpImportPreviewReferenceSchema.parse(
        job.result?.importPreview,
      );
      const review = await f.inspect(ref);
      expect(review.warnings.join(" ")).toContain("truncated: true");
      expect(JSON.stringify(review)).not.toMatch(
        /private-preview|sourcePath|authorized-input/,
      );
      const input = await f.command(ref);
      input.chapters[0].pageIds.reverse();
      if (mode === "subset")
        input.chapters[0].pageIds = input.chapters[0].pageIds.slice(0, 1);
      const receipt = await f.create(input);
      expect(receipt.source).toBe("web");
      const chapter = await f.library.openChapter(receipt.chapterIds[0]);
      const expected =
        mode === "subset" ? ["web-2.png"] : ["web-2.png", "web-1.png"];
      expect(chapter.pages.map((page) => page.name)).toEqual(expected);
      expect(chapter.pages.map((page) => basename(page.imagePath))).toEqual(
        expected.map((_name, index) => `${index + 1}.png`),
      );
      expect(await readFile(chapter.pages[0].imagePath)).toEqual(
        await readFile(f.originals[1]),
      );
      expect((await f.inspect(ref)).pages).toEqual(review.pages);
      expect(web.scan).toHaveBeenCalledOnce();
      expect(web.discardSession).toHaveBeenCalledOnce();
      expect(web.releasePrepared).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
    expect(web.dispose).toHaveBeenCalledOnce();
  },
);

it("rejects private-network URLs through the existing web policy and never removes native UI import staging", async () => {
  const f = await libraryImportFixture();
  try {
    const ui = join(f.env.root, "tmp", "web-import");
    await mkdir(ui, { recursive: true });
    const sentinel = join(ui, "native-ui-input.txt");
    await writeFile(sentinel, "UI-owned input stays intact");
    const done = await f.settle(
      await f.invoke("carrot_scan_import_url", {
        source: "web",
        url: "http://127.0.0.1/private",
        allowNetwork: true,
        requestId: randomUUID(),
      }),
    );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect(done.error?.message).toContain("private-address");
    expect(await readFile(sentinel, "utf8")).toBe(
      "UI-owned input stays intact",
    );
    await f.restart();
    expect(await readFile(sentinel, "utf8")).toBe(
      "UI-owned input stays intact",
    );
    expect(f.validate).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
