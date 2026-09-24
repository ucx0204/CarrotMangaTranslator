import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { expect, it } from "vitest";
import { importDuplicateFixture } from "./mcpImportDuplicate.fixture";
import { McpImportPreviewReferenceSchema } from "../src/shared/mcpLibraryImport";
import { identifyMcpImportSources } from "../src/main/mcp/mcpImportSourceEvidence";
import type { ImportChapterDraft } from "../src/shared/importTypes";

it("matches selected ZIP image bytes despite different archive entries and ignores unselected members", async () => {
  const f = await importDuplicateFixture();
  try {
    const first = await f.command(await f.prepare());
    const receipt = await f.create(first);
    const archive = join(f.env.root, "renamed.cbz");
    const zip = new AdmZip();
    zip.addFile("renamed/01.png", await readFile(f.originals[0]));
    zip.addFile("renamed/02.png", await readFile(f.originals[1]));
    zip.addFile("renamed/03.png", await readFile(f.originals[0]));
    zip.addFile("unselected-notes.txt", Buffer.from("not input evidence"));
    zip.writeZip(archive);
    f.choose.mockResolvedValueOnce([archive]);
    const done = await f.settle(
      await f.invoke("carrot_choose_import_files", {
        source: "local",
        kind: "archive",
        requestId: randomUUID(),
      }),
    );
    expect(done.status).toBe("completed");
    const input = await f.command(
      McpImportPreviewReferenceSchema.parse(done.result?.importPreview),
    );
    input.target = await f.target(receipt.workId);
    input.chapters[0].pageIds = input.chapters[0].pageIds.slice(0, 2);
    const review = await f.review(input);
    expect(review.chapters[0]).toMatchObject({
      status: "known-content",
      matches: [{ chapterId: receipt.chapterIds[0], match: "content" }],
    });
    expect(f.validate).toHaveBeenCalledTimes(2);
    input.chapters[0].pageIds.reverse();
    expect((await f.review(input)).chapters[0].status).toBe("unseen");
    expect(await readFile(archive)).toEqual(zip.toBuffer());
  } finally {
    await f.close();
  }
});

it("rejects unowned native source evidence and respects exact expanded-byte and cancellation bounds", async () => {
  const f = await importDuplicateFixture();
  try {
    const archive = join(f.env.root, "native-source.zip");
    const zip = new AdmZip();
    zip.addFile("one.png", f.bytes);
    zip.writeZip(archive);
    const source = {
      path: archive,
      bytes: (await readFile(archive)).length,
      sha256: createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
    };
    const chapter: ImportChapterDraft = {
      draftId: randomUUID(),
      title: "Native evidence",
      sourceKind: "zip",
      pages: [
        {
          name: "one.png",
          sourcePath: archive,
          sourceKind: "zip-entry",
          zipEntryName: "one.png",
        },
      ],
    };
    await expect(
      identifyMcpImportSources([chapter], [], () => {}),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    const missing = structuredClone(chapter);
    missing.pages[0].zipEntryName = undefined;
    await expect(
      identifyMcpImportSources([missing], [source], () => {}),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    missing.pages[0].zipEntryName = "not-in-archive.png";
    await expect(
      identifyMcpImportSources([missing], [source], () => {}),
    ).rejects.toThrow();
    await expect(
      identifyMcpImportSources(
        [chapter],
        [source],
        () => {},
        "https://user:password@example.com",
      ),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    let checks = 0;
    await expect(
      identifyMcpImportSources([chapter], [source], () => {
        if (++checks === 2)
          throw new Error("fixture cancelled after archive read");
      }),
    ).rejects.toThrow("fixture cancelled");
    const fileChapter = {
      ...chapter,
      pages: [
        { name: "file.png", sourcePath: "owned", sourceKind: "file" as const },
      ],
    };
    const boundary = {
      path: "owned",
      sha256: "b".repeat(64),
      bytes: 256 * 1024 * 1024,
    };
    expect(
      (await identifyMcpImportSources([fileChapter], [boundary], () => {}))[0]
        .importSource?.pageCount,
    ).toBe(1);
    await expect(
      identifyMcpImportSources(
        [fileChapter],
        [{ ...boundary, bytes: boundary.bytes + 1 }],
        () => {},
      ),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    const exhausted = {
      ...fileChapter,
      pages: [...fileChapter.pages, ...fileChapter.pages],
    };
    await expect(
      identifyMcpImportSources([exhausted], [boundary], () => {}),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    expect(
      (await identifyMcpImportSources([chapter], [source], () => {}))[0]
        .importSource?.pageCount,
    ).toBe(1);
  } finally {
    await f.close();
  }
});
