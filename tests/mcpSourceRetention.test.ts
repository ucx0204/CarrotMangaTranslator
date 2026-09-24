import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import { readExportZip } from "./mcpExportBatch.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpRetentionOutputs } from "../src/shared/mcpRetention";

const token = (url: string) => new URL(url).pathname.split("/")[2];
type Output = {
  url: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  retainedOutputId?: string;
};

/** Native source evidence, ownership, encryption and ZIP; only renderer bytes are supplied. */
async function sourceRetentionFixture() {
  const f = await retentionFixture();
  const { McpPageExportService } =
    await import("../src/main/application/mcpPageExportService");
  const { bindRetainedOutputSource } =
    await import("../src/main/mcp/mcpRetainedOutputs");
  const { readMcpExportSourceName } =
    await import("../src/main/mcp/mcpSourceExport");
  const { RetainedOutputSchema } =
    await import("../src/main/mcp/mcpRetentionRecords");
  const bytes = Buffer.from("encoded JPEG renderer boundary");
  const render = vi.fn(async () => bytes);
  const publish = async (bindName = true) => {
    const page = (await f.snapshot()).pages[0];
    const artifacts = f.operations().artifacts;
    const source = readMcpExportSourceName(page);
    const exporter = new McpPageExportService({
      openChapter: f.library.openChapter,
      render,
      store: artifacts.put.bind(artifacts),
      image: { render, store: artifacts.putImage.bind(artifacts) },
      bindSource: bindRetainedOutputSource,
      assertImageAccess: async () => {},
    });
    return ownedOutput(f, "carrot_export_pages_images", () =>
      exporter.exportImage(
        {
          chapterId: "chapter",
          pageId: page.id,
          revision: createPageRevision(page),
          ...(bindName
            ? { sourceNameFingerprint: source.sourceNameFingerprint }
            : {}),
          imageExport: { format: "jpeg", quality: 81, omitText: false },
        },
        {
          id: randomUUID(),
          signal: new AbortController().signal,
          assertAuthorized: () => {},
          progress: () => {},
        },
      ),
    );
  };
  return {
    ...f,
    bytes,
    render,
    publish,
    sourceName: readMcpExportSourceName,
    record: async (id: string) =>
      RetainedOutputSchema.parse(await f.storage.record(id)),
    issue: async (id: string) =>
      mcpRetentionOutputs.carrot_get_output_file.parse(
        (await f.invoke("carrot_get_output_file", { id })).structuredContent,
      ),
    zip: (url: string) =>
      ownedOutput(f, "carrot_create_export_zip", () =>
        f
          .operations()
          .artifacts.zip(
            [{ url, filename: "001.jpg" }],
            { pages: ["page"], sourceFormat: true },
            async () => {},
            new AbortController().signal,
          ),
      ),
  };
}

async function ownedOutput<T extends Output>(
  f: Awaited<ReturnType<typeof retentionFixture>>,
  name: string,
  run: () => Promise<T>,
) {
  const wrap = f.operations().wrapTool;
  if (!wrap) throw new Error("Native retention must be connected");
  let output: T | undefined;
  const tool = wrap({
    name,
    description: "Saved-source output retention fixture",
    inputSchema: { type: "object" },
    readOnly: true,
    requiredScopes: ["carrot.read", "carrot.images"],
    invoke: async () => {
      output = await run();
      return [];
    },
  });
  await tool.invoke({ requestId: randomUUID() }, f.auth());
  if (!output?.retainedOutputId) throw new Error("Output was not retained");
  return { ...output, id: output.retainedOutputId };
}

async function renameSource(
  f: Awaited<ReturnType<typeof sourceRetentionFixture>>,
  field: "name" | "sourceFileName",
  value: string,
) {
  const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
  if (field === "name") delete chapter.pages[0].sourceFileName;
  chapter.pages[0][field] = value;
  await writeFile(f.chapterPath, JSON.stringify(chapter));
}

async function collect(stream: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

it("retains encrypted source-name evidence and exact image/ZIP bytes across reconstruction", async () => {
  const f = await sourceRetentionFixture();
  try {
    await renameSource(f, "sourceFileName", "source.JPEG");
    const page = (await f.snapshot()).pages[0];
    const original = await readFile(page.imagePath);
    const chapter = await readFile(f.chapterPath);
    const fingerprint = f.sourceName(page).sourceNameFingerprint;
    const output = await f.publish();
    const archive = await f.zip(output.url);
    const old = f.operations().artifacts;
    const zipBytes = await old.read(token(archive.url));
    expect(readExportZip(zipBytes)["001.jpg"]).toEqual(f.bytes);
    const record = await f.record(output.id);
    expect(record.targets[0].sourceNameFingerprint).toBe(fingerprint);
    expect((await f.record(archive.id)).targets[0].sourceNameFingerprint).toBe(
      fingerprint,
    );
    const envelope = JSON.parse(
      await readFile(await f.storage.path(output.id), "utf8"),
    );
    expect(Object.keys(envelope)).toEqual(["encrypted"]);
    expect(JSON.stringify(envelope)).not.toContain(fingerprint);
    expect(await f.codec.open(envelope)).toEqual(record);

    await f.restart();
    await expect(old.read(token(output.url))).rejects.toThrow();
    let renewedImage = "";
    for (const [saved, expected] of [
      [output, f.bytes],
      [archive, zipBytes],
    ] as const) {
      const issued = await f.issue(saved.id);
      expect(issued.url).not.toBe(saved.url);
      expect(await f.operations().artifacts.read(token(issued.url))).toEqual(
        expected,
      );
      expect((await f.record(saved.id)).targets[0].sourceNameFingerprint).toBe(
        fingerprint,
      );
      expect(JSON.stringify(issued)).not.toContain("source.JPEG");
      if (saved === output) renewedImage = issued.url;
    }
    const renewedZip = await f.zip(renewedImage);
    expect(
      (await f.record(renewedZip.id)).targets[0].sourceNameFingerprint,
    ).toBe(fingerprint);
    expect(
      readExportZip(await f.operations().artifacts.read(token(renewedZip.url)))[
        "001.jpg"
      ],
    ).toEqual(f.bytes);
    expect(await readFile(f.chapterPath)).toEqual(chapter);
    await renameSource(f, "sourceFileName", "renamed.JPEG");
    await expect(f.issue(renewedZip.id)).rejects.toThrow();
    expect(f.render).toHaveBeenCalledTimes(1);
    expect(f.acquireEngine).not.toHaveBeenCalled();
    expect(await readFile(page.imagePath)).toEqual(original);
    await writeFile(f.chapterPath, chapter);
  } finally {
    await f.close();
  }
});

it.each([
  ["name", "renamed.JPEG"],
  ["sourceFileName", "source.WEBP"],
] as const)(
  "denies original and retained image/ZIP access after only %s changes",
  async (field, changedName) => {
    const f = await sourceRetentionFixture();
    try {
      await renameSource(f, field, "source.JPEG");
      const before = (await f.snapshot()).pages[0];
      const output = await f.publish();
      const archive = await f.zip(output.url);
      const artifacts = f.operations().artifacts;
      const directStreams = await Promise.all([
        artifacts.open(token(output.url), "page.jpg"),
        artifacts.open(token(archive.url), "pages.zip"),
      ]);
      const issued = await Promise.all([
        f.issue(output.id),
        f.issue(archive.id),
      ]);
      const retainedStreams = await Promise.all([
        artifacts.open(token(issued[0].url), "page.jpg"),
        artifacts.open(token(issued[1].url), "pages.zip"),
      ]);
      const savedBytes = await Promise.all(
        [output, archive].map(async (item) => ({
          path: await f.storage.path(item.id, item.sha256),
          bytes: await artifacts.read(token(item.url)),
        })),
      );
      await renameSource(f, field, changedName);
      const after = (await f.snapshot()).pages[0];
      expect(createPageRevision(after)).toBe(createPageRevision(before));
      expect(f.sourceName(after).sourceNameFingerprint).not.toBe(
        f.sourceName(before).sourceNameFingerprint,
      );
      for (const opened of [...directStreams, ...retainedStreams])
        await expect(collect(opened.stream())).rejects.toThrow();
      for (const item of [output, archive]) {
        await expect(artifacts.read(token(item.url))).rejects.toThrow();
        await expect(f.issue(item.id)).rejects.toThrow();
      }
      for (const saved of savedBytes)
        expect(await readFile(saved.path)).toEqual(saved.bytes);
      expect((await f.list("outputs")).total).toBe(2);
      expect(f.render).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  },
);

it("rechecks source naming during encrypted staging before admitting a native retained output", async () => {
  const f = await sourceRetentionFixture();
  let restore = () => {};
  try {
    await renameSource(f, "sourceFileName", "source.JPEG");
    const page = (await f.snapshot()).pages[0];
    const changed = JSON.parse(await readFile(f.chapterPath, "utf8"));
    changed.pages[0].sourceFileName = "concurrent.JPEG";
    const changedBytes = Buffer.from(JSON.stringify(changed));
    const encrypt = f.encryption.encrypt;
    let injected = false;
    const hook = vi
      .spyOn(f.encryption, "encrypt")
      .mockImplementation((text) => {
        const encrypted = encrypt(text);
        const envelope = JSON.parse(text);
        if (
          !injected &&
          envelope.payload?.targets?.[0]?.sourceNameFingerprint
        ) {
          injected = true;
          // External native-encryption boundary, after output bytes were staged.
          writeFileSync(f.chapterPath, changedBytes);
        }
        return encrypted;
      });
    restore = () => hook.mockRestore();
    await expect(f.publish()).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(injected).toBe(true);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(await readFile(f.chapterPath)).toEqual(changedBytes);
    expect(createPageRevision((await f.snapshot()).pages[0])).toBe(
      createPageRevision(page),
    );
    expect(f.render).toHaveBeenCalledTimes(1);
  } finally {
    restore();
    await f.close();
  }
});

it("keeps legacy explicit raster records without source-name evidence readable after a name-only edit", async () => {
  const f = await sourceRetentionFixture();
  try {
    await renameSource(f, "sourceFileName", "source.JPEG");
    const before = (await f.snapshot()).pages[0];
    const output = await f.publish(false);
    const archive = await f.zip(output.url);
    for (const item of [output, archive])
      expect((await f.record(item.id)).targets[0]).not.toHaveProperty(
        "sourceNameFingerprint",
      );
    const zipBytes = await f.operations().artifacts.read(token(archive.url));
    await renameSource(f, "sourceFileName", "renamed.WEBP");
    expect(createPageRevision((await f.snapshot()).pages[0])).toBe(
      createPageRevision(before),
    );
    expect(await f.operations().artifacts.read(token(output.url))).toEqual(
      f.bytes,
    );
    await f.restart();
    for (const [item, expected] of [
      [output, f.bytes],
      [archive, zipBytes],
    ] as const) {
      const issued = await f.issue(item.id);
      expect(await f.operations().artifacts.read(token(issued.url))).toEqual(
        expected,
      );
    }
    expect(f.render).toHaveBeenCalledTimes(1);
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
