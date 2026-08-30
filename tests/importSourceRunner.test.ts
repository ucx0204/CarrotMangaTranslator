import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareArchiveFolderImportPreview,
  prepareArchiveImportPreview,
  preparePdfImportPreview,
} from "../src/main/libraryStore/importPreparedPreview";
import { resolveImportSourceRunner } from "../src/main/libraryStore/importSourceRunner";

const tempDirs: string[] = [];
const runnerPath = resolveImportSourceRunner();

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("native import source runner", () => {
  it.runIf(Boolean(runnerPath))(
    "renders a real PDF and removes staged pages on cleanup",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "import-runner-test-"));
      tempDirs.push(root);
      const pdfPath = join(root, "sample.pdf");
      await writeFile(pdfPath, makeMinimalPdf());
      const progress: Array<{ current: number; total: number; unit: string }> =
        [];

      const prepared = await preparePdfImportPreview(
        pdfPath,
        undefined,
        (event) => progress.push(event),
      );
      const pages = prepared.preview.chapters[0]?.pages ?? [];

      expect(prepared.preview.sourceKind).toBe("pdf");
      expect(pages).toHaveLength(1);
      expect(pages[0].name).toBe("sample-001.png");
      expect(pages[0].sourceKind).toBe("file");
      expect(existsSync(pages[0].sourcePath)).toBe(true);
      expect(progress[0]).toMatchObject({
        current: 0,
        total: 1,
        unit: "items",
      });
      expect(progress.at(-1)).toMatchObject({
        current: 1,
        total: 1,
        unit: "items",
      });
      const stagingRoot = dirname(pages[0].sourcePath);
      await prepared.cleanup?.();
      await expect(access(stagingRoot)).rejects.toThrow();
      await prepared.cleanup?.();
    },
  );

  it.runIf(Boolean(runnerPath))(
    "extracts a real CBR in natural page order",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "import-runner-cbr-test-"));
      tempDirs.push(root);
      const cbrPath = join(root, "sample.cbr");
      const fixtureHex = await readFile(
        join(
          process.cwd(),
          "tests",
          "fixtures",
          "import-source",
          "sample.cbr.hex",
        ),
        "utf8",
      );
      await writeFile(cbrPath, Buffer.from(fixtureHex.trim(), "hex"));
      const progress: Array<{ current: number; total: number; unit: string }> =
        [];

      const prepared = await prepareArchiveImportPreview(
        cbrPath,
        undefined,
        (event) => progress.push(event),
      );
      const pages = prepared.preview.chapters[0]?.pages ?? [];

      expect(prepared.preview.sourceKind).toBe("rar");
      expect(pages.map((page) => page.name)).toEqual([
        "page2.png",
        "page10.png",
      ]);
      expect(progress[0]).toMatchObject({
        current: 0,
        total: 2,
        unit: "items",
      });
      expect(progress.at(-1)).toMatchObject({
        current: 2,
        total: 2,
        unit: "items",
      });
      await Promise.all(pages.map((page) => access(page.sourcePath)));
      const stagingRoot = dirname(pages[0].sourcePath);
      await prepared.cleanup?.();
      await expect(access(stagingRoot)).rejects.toThrow();
    },
  );

  it.runIf(Boolean(runnerPath))(
    "adds CBR files from an archive folder preview and cleans every stage",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "import-runner-folder-test-"));
      tempDirs.push(root);
      const fixtureHex = await readFile(
        join(
          process.cwd(),
          "tests",
          "fixtures",
          "import-source",
          "sample.cbr.hex",
        ),
        "utf8",
      );
      await writeFile(
        join(root, "chapter.cbr"),
        Buffer.from(fixtureHex.trim(), "hex"),
      );

      const prepared = await prepareArchiveFolderImportPreview(root);
      const pages = prepared.preview.chapters[0]?.pages ?? [];

      expect(prepared.preview.mode).toBe("batch");
      expect(pages.map((page) => page.name)).toEqual([
        "page2.png",
        "page10.png",
      ]);
      const stagingRoot = dirname(pages[0].sourcePath);
      await prepared.cleanup?.();
      await expect(access(stagingRoot)).rejects.toThrow();
    },
  );
});

function makeMinimalPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 25 >>\nstream\n0 0 0 rg 0 0 72 72 re f\nendstream",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += String(index + 1) + " 0 obj\n" + object + "\nendobj\n";
  });
  const xrefOffset = Buffer.byteLength(body);
  body += "xref\n0 5\n0000000000 65535 f \n";
  offsets.forEach((offset) => {
    body += String(offset).padStart(10, "0") + " 00000 n \n";
  });
  body +=
    "trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n" +
    String(xrefOffset) +
    "\n%%EOF\n";
  return Buffer.from(body);
}
