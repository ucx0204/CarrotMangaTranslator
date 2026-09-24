import { createHash } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../src/shared/pageRevision";
import { SOUND_EFFECT_REVIEW_CONTRACT_VERSION } from "../src/shared/soundEffectReview";
import type { NativeImportedPageEvidence } from "../src/main/libraryStore/importPublicationEvidence";

it("revalidates exact stored bytes, captured source bytes and the whole saved page revision before publication", async () => {
  const f = await libraryImportFixture();
  try {
    const {
      nativeImportDigest,
      observeNativeImportedPage,
      fingerprintNativeImportFiles,
    } = await import("../src/main/libraryStore/importPublicationEvidence");
    const page = structuredClone(
      (await f.library.openChapter("chapter")).pages[0],
    );
    const source = Buffer.from(f.bytes);
    const originalPath = join(f.env.root, "evidence-original.png");
    const inpaintedPath = join(f.env.root, "evidence-inpainted.png");
    page.inpaintedImagePath = inpaintedPath;
    delete page.inpaintMaskPath;
    await writeFile(originalPath, source);
    await writeFile(inpaintedPath, await readFile(f.originals[1]));
    const originalDigest = {
      role: "original" as const,
      ...(await nativeImportDigest(originalPath)),
    };
    const processedDigest = {
      role: "inpainted" as const,
      ...(await nativeImportDigest(inpaintedPath)),
    };
    expect(
      fingerprintNativeImportFiles([originalDigest, processedDigest]),
    ).toBe(fingerprintNativeImportFiles([processedDigest, originalDigest]));
    expect(
      fingerprintNativeImportFiles([
        originalDigest,
        { ...processedDigest, role: "mask" },
      ]),
    ).not.toBe(fingerprintNativeImportFiles([originalDigest, processedDigest]));
    expect(() => fingerprintNativeImportFiles([processedDigest])).toThrow();
    expect(() =>
      fingerprintNativeImportFiles([originalDigest, originalDigest]),
    ).toThrow();
    let evidence: NativeImportedPageEvidence | undefined;
    let verify: (() => Promise<void>) | undefined;
    await observeNativeImportedPage({
      observation: {
        observe: (value, check) => {
          evidence = value;
          verify = check;
        },
        kind: "image",
        workId: "work",
        chapterId: "chapter",
        sourceChapterId: "draft",
      },
      page,
      pageIndex: 0,
      sourceValue: source,
      source: { ...(await nativeImportDigest(source)), format: "png" },
      originalPath,
      inpaintedPath,
      originalFormat: "png",
    });
    if (!verify || !evidence)
      throw new Error("Native evidence observer did not run");
    await verify();
    expect(evidence.page.reviewRevision).toBe(
      createSoundEffectReviewPageRevision(page),
    );
    expect(evidence.page.blockIdsSha256).toBe(
      createHash("sha256")
        .update(JSON.stringify(page.blocks.map((block) => block.id)))
        .digest("hex"),
    );
    source[0] ^= 1;
    await expect(verify()).rejects.toThrow("changed before");
    source[0] ^= 1;
    await verify();
    await writeFile(originalPath, await readFile(f.originals[1]));
    await expect(verify()).rejects.toThrow("changed before");
    await writeFile(originalPath, source);
    const unchangedRevision = evidence.page.revision;
    await writeFile(inpaintedPath, source);
    await expect(verify()).rejects.toThrow("changed before");
    expect(createPageRevision(page)).toBe(unchangedRevision);
    await writeFile(inpaintedPath, await readFile(f.originals[1]));
    await verify();
    const savedReview = page.soundEffectReview;
    page.soundEffectReview = {
      contractVersion: SOUND_EFFECT_REVIEW_CONTRACT_VERSION,
      producer: "hayai-regions-v1",
      regions: [],
      regionOverrides: [],
      manualRegions: [],
      resolvedRegions: [],
    };
    expect(createPageRevision(page)).toBe(unchangedRevision);
    expect(createSoundEffectReviewPageRevision(page)).not.toBe(
      evidence.page.reviewRevision,
    );
    await expect(verify()).rejects.toThrow("changed before");
    if (savedReview) page.soundEffectReview = savedReview;
    else delete page.soundEffectReview;
    await verify();
    page.blocks[0].translatedText = "Changed after evidence capture";
    await expect(verify()).rejects.toThrow("changed before");
    await expect(nativeImportDigest(f.env.root)).rejects.toThrow(
      "regular file",
    );
    await expect(
      nativeImportDigest(source, AbortSignal.abort()),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("preserves native raw-file and absence authority while bounding and rechecking publication metadata", async () => {
  const f = await libraryImportFixture();
  let restore = () => {};
  try {
    const { readNativeMetadataFileVersion } =
      await import("../src/main/libraryStore/workContextMigration");
    const storage =
      await import("../src/main/libraryStore/libraryTransactionStorage");
    const path = join(f.env.libraryDir, "metadata-evidence.json");
    expect(await readNativeMetadataFileVersion(path, 4)).toBeNull();
    const bytes = Buffer.from("null");
    await writeFile(path, bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(await readNativeMetadataFileVersion(path)).toBe(expected);
    expect(await readNativeMetadataFileVersion(path, 4)).toBe(expected);
    await expect(readNativeMetadataFileVersion(path, 3)).rejects.toThrow(
      "byte limit",
    );
    const digest = storage.sha256File;
    for (const limit of [4, 8]) {
      await writeFile(path, bytes);
      const spy = vi
        .spyOn(storage, "sha256File")
        .mockImplementationOnce(async (file, maxBytes) => {
          const value = await digest(file, maxBytes);
          await writeFile(file, Buffer.concat([bytes, Buffer.from(" ")]));
          return value;
        });
      restore = () => spy.mockRestore();
      await expect(readNativeMetadataFileVersion(path, limit)).rejects.toThrow(
        limit === 4 ? "byte limit" : "changed while",
      );
      restore();
    }
  } finally {
    restore();
    await f.close();
  }
});

it("uses the native SHA reader with a strict byte cap when the opened file grows after stat", async () => {
  const f = await libraryImportFixture();
  const restorers: Array<() => void> = [];
  try {
    const { sha256File } =
      await import("../src/main/libraryStore/libraryTransactionStorage");
    const path = join(f.env.libraryDir, "growing-metadata.json");
    await writeFile(path, "null");
    expect(await sha256File(path, 4)).toBe(await sha256File(path));
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    await probe.close();
    const stat = prototype.stat;
    const statSpy = vi
      .spyOn(prototype, "stat")
      .mockImplementationOnce(async function (this: typeof probe) {
        const before = await stat.call(this);
        await writeFile(path, Buffer.alloc(1024 * 1024));
        return before;
      });
    restorers.push(() => statSpy.mockRestore());
    const readSpy = vi.spyOn(prototype, "read");
    restorers.push(() => readSpy.mockRestore());
    await expect(sha256File(path, 4)).rejects.toThrow("byte limit");
    expect(statSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(await readSpy.mock.results[0].value).toMatchObject({ bytesRead: 5 });
  } finally {
    for (const restore of restorers.reverse()) restore();
    await f.close();
  }
});
