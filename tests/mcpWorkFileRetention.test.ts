import { createHash, randomUUID } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import { mcpRetentionOutputs } from "../src/shared/mcpRetention";
import { RetainedOutputSchema } from "../src/main/mcp/mcpRetentionRecords";
import type { McpArtifactStore } from "../src/main/mcp/mcpArtifactStore";
import type { McpArtifactMime } from "../src/shared/mcpOutputFormats";

vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return { ...actual, copyFile: vi.fn(actual.copyFile) };
});

const token = (url: string) => new URL(url).pathname.split("/")[2];
async function collect(stream: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Actual native archive, encrypted retention and reconstructed sessions; no engine runs. */
async function workFileRetentionFixture() {
  const f = await retentionFixture();
  const files = await import("../src/main/libraryStore/libraryFiles");
  const context = await import("../src/main/libraryStore/workContextFiles");
  const source = await import("../src/main/mcp/mcpWorkFileExportSource");
  const work = await files.readWorkFile("work");
  const chapter = await files.readChapterFile("work", "chapter");
  if (!work || !chapter) throw new Error("Expected saved fixture records");
  const savedWork = { ...work, chapterOrder: ["chapter", "empty"] };
  await files.writeChapterFile({
    ...chapter,
    id: "empty",
    title: "Selected empty chapter",
    pages: [],
    pageOrder: [],
  });
  await files.writeWorkFile(savedWork);
  const guide = await context.writeWorkStyleGuide(
    await context.readWorkStyleGuide("work"),
  );
  const workPath = join(f.env.libraryDir, "works", "work", "work.json");
  const guidePath = join(f.env.libraryDir, "works", "work", "style-guide.json");
  const originals = await Promise.all(
    [
      workPath,
      f.chapterPath,
      guidePath,
      ...chapter.pages.map((page) => page.imagePath),
    ].map(async (path) => ({ path, bytes: await readFile(path) })),
  );
  const state = await source.readMcpWorkFileExportState(
    { workId: "work", chapterIds: ["chapter", "empty"] },
    () => {},
  );
  const binding = {
    workId: state.review.workId,
    chapterIds: state.review.chapterIds,
    snapshot: state.review.snapshot,
  };
  let nativeWrites = 0,
    lastFile = "";
  const publish = async (
    afterWrite?: () => Promise<void>,
    signal = new AbortController().signal,
  ) => {
    const artifacts = f.operations().artifacts;
    const wrap = f.operations().wrapTool;
    if (!wrap) throw new Error("Native retention must be connected");
    let output:
      | Awaited<ReturnType<McpArtifactStore["putWorkFile"]>>
      | undefined;
    const tool = wrap({
      name: "carrot_export_work_file",
      description: "Native workfile and retention integration fixture",
      inputSchema: { type: "object" },
      readOnly: true,
      requiredScopes: ["carrot.read", "carrot.images"],
      invoke: async () => {
        output = await artifacts.putWorkFile(
          async (path, writerSignal) => {
            lastFile = path;
            nativeWrites++;
            await source.writeMcpWorkFileExport(
              binding,
              path,
              () => {},
              writerSignal,
            );
            await afterWrite?.();
          },
          128 * 1024 * 1024,
          // Deliberately authorize unchanged page access. Native retention must
          // independently enforce the saved work/chapter/guide binding.
          async () => {},
          signal,
          state.bindings,
          binding,
        );
        return [];
      },
    });
    await tool.invoke({ requestId: randomUUID() }, f.auth());
    if (!output?.retainedOutputId) throw new Error("Missing retained workfile");
    return { ...output, id: output.retainedOutputId };
  };
  const changes = [
    {
      name: "work title",
      path: workPath,
      value: { ...savedWork, title: "Renamed work" },
    },
    {
      name: "chapter order",
      path: workPath,
      value: { ...savedWork, chapterOrder: ["empty", "chapter"] },
    },
    {
      name: "page order",
      path: f.chapterPath,
      value: { ...chapter, pageOrder: [...chapter.pageOrder].reverse() },
    },
    {
      name: "style guide",
      path: guidePath,
      value: { ...guide, rules: { ...guide.rules, defaultTone: "literal" } },
    },
  ];
  return {
    ...f,
    binding,
    publish,
    changes,
    originals,
    nativeWrites: () => nativeWrites,
    lastFile: () => lastFile,
    restore: async () => {
      for (const { path, bytes } of originals) await writeFile(path, bytes);
    },
    issue: async (id: string) =>
      mcpRetentionOutputs.carrot_get_output_file.parse(
        (await f.invoke("carrot_get_output_file", { id })).structuredContent,
      ),
  };
}

it("preserves encrypted work bindings and exact native bytes across reconstruction without running a writer again", async () => {
  const f = await workFileRetentionFixture();
  try {
    const output = await f.publish();
    const file = await f.storage.path(output.id, output.sha256);
    const bytes = await readFile(file);
    const record = RetainedOutputSchema.parse(
      await f.storage.record(output.id),
    );
    expect(record.workFileBinding).toEqual(f.binding);
    expect(record.targets).toHaveLength(2);
    expect(record.workFileBinding?.chapterIds).toEqual(["chapter", "empty"]);
    const encrypted = JSON.parse(
      await readFile(await f.storage.path(output.id), "utf8"),
    );
    expect(Object.keys(encrypted)).toEqual(["encrypted"]);
    expect(await f.codec.open(encrypted)).toEqual(record);
    expect(JSON.stringify(encrypted)).not.toContain(f.binding.snapshot);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      output.sha256,
    );
    const old = f.operations().artifacts;
    await f.restart();
    await expect(
      old.open(token(output.url), "work.mgtshare"),
    ).rejects.toThrow();
    const issued = await f.issue(output.id);
    expect(issued.url).not.toBe(output.url);
    expect(issued.mimeType).toBe("application/vnd.carrot.mgtshare");
    const opened = await f
      .operations()
      .artifacts.open(token(issued.url), "work.mgtshare");
    expect(await collect(opened.stream())).toEqual(bytes);
    expect(
      RetainedOutputSchema.parse(await f.storage.record(output.id)),
    ).toEqual(record);
    expect(f.nativeWrites()).toBe(1);
    expect(f.acquireEngine).not.toHaveBeenCalled();
    for (const original of f.originals)
      expect(await readFile(original.path)).toEqual(original.bytes);
  } finally {
    await f.close();
  }
});

it("rejects a malformed encrypted work binding after reconstruction without reissuing or replacing its archive", async () => {
  const f = await workFileRetentionFixture();
  try {
    const output = await f.publish();
    const recordPath = await f.storage.path(output.id);
    const originalRecord = await readFile(recordPath);
    const archivePath = await f.storage.path(output.id, output.sha256);
    const archive = await readFile(archivePath);
    const record = RetainedOutputSchema.parse(
      await f.storage.record(output.id),
    );
    const invalid = {
      ...record,
      workFileBinding: { ...f.binding, snapshot: "invalid-snapshot" },
    };
    await writeFile(recordPath, JSON.stringify(await f.codec.seal(invalid)));
    await f.restart();
    await expect(f.issue(output.id)).rejects.toThrow(
      "Invalid retained working-file export binding.",
    );
    expect((await f.list("outputs")).total).toBe(1);
    expect((await readFile(archivePath)).equals(archive)).toBe(true);
    expect(f.nativeWrites()).toBe(1);
    expect(f.acquireEngine).not.toHaveBeenCalled();
    for (const original of f.originals)
      expect((await readFile(original.path)).equals(original.bytes)).toBe(true);
    // Restoring valid owned metadata makes the same retained bytes available.
    await writeFile(recordPath, originalRecord);
    const issued = await f.issue(output.id);
    const opened = await f
      .operations()
      .artifacts.open(token(issued.url), "work.mgtshare");
    expect((await collect(opened.stream())).equals(archive)).toBe(true);
    expect(f.nativeWrites()).toBe(1);
  } finally {
    await f.close();
  }
});

it("rejects changed work metadata, selection order and guide at publication without retaining stale bytes", async () => {
  const f = await workFileRetentionFixture();
  try {
    for (const change of f.changes) {
      await expect(
        f.publish(() => writeFile(change.path, JSON.stringify(change.value))),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      expect((await f.list("outputs")).total, change.name).toBe(0);
      await expect(readFile(f.lastFile())).rejects.toMatchObject({
        code: "ENOENT",
      });
      await f.restore();
    }
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.restore();
    await f.close();
  }
});

it("denies reissue and already opened streams after metadata changes while preserving retained bytes", async () => {
  const f = await workFileRetentionFixture();
  try {
    const output = await f.publish();
    const file = await f.storage.path(output.id, output.sha256);
    const bytes = await readFile(file);
    await f.restart();
    for (const change of f.changes) {
      const issued = await f.issue(output.id);
      const opened = await f
        .operations()
        .artifacts.open(token(issued.url), "work.mgtshare");
      await writeFile(change.path, JSON.stringify(change.value));
      await expect(f.issue(output.id)).rejects.toThrow();
      await expect(collect(opened.stream())).rejects.toMatchObject({
        code: "revision_conflict",
      });
      expect(await readFile(file), change.name).toEqual(bytes);
      expect((await f.list("outputs")).total).toBe(1);
      await f.restore();
    }
    const restored = await f.issue(output.id);
    const opened = await f
      .operations()
      .artifacts.open(token(restored.url), "work.mgtshare");
    expect(await collect(opened.stream())).toEqual(bytes);
    expect(f.nativeWrites()).toBe(1);
  } finally {
    await f.restore();
    await f.close();
  }
});

it("rolls back native retained publication when cancellation arrives during durable copying", async () => {
  const f = await workFileRetentionFixture();
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const operation = new AbortController();
  const cancelled = new Error("cancelled during native retention");
  let entered: () => void = () => {},
    release: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(copyFile).mockImplementation(async (...args) => {
    await actual.copyFile(...args);
    if (String(args[0]) === f.lastFile()) {
      entered();
      await finish;
    }
  });
  const pending = f.publish(undefined, operation.signal);
  const rejected = expect(pending).rejects.toBe(cancelled);
  try {
    await Promise.race([
      started,
      pending.then(() => {
        throw new Error("Publication bypassed the controlled file copy");
      }),
    ]);
    operation.abort(cancelled);
    release();
    await rejected;
    expect((await f.list("outputs")).total).toBe(0);
    await expect(readFile(f.lastFile())).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const original of f.originals)
      expect(await readFile(original.path)).toEqual(original.bytes);
  } finally {
    release();
    await Promise.allSettled([pending, rejected]);
    vi.mocked(copyFile).mockImplementation(actual.copyFile);
    await f.close();
  }
});

function historicalRecord(mimeType: McpArtifactMime) {
  return {
    version: 1,
    id: randomUUID(),
    owner: "owner",
    mimeType,
    sha256: "0".repeat(64),
    bytes: 1,
    targets: [
      {
        workId: "work",
        chapterId: "chapter",
        pageId: "page",
        revision: "page-v1:0000000000000000",
        files: [
          {
            path: "/fixture/original.png",
            sha256: "1".repeat(64),
            bytes: 1,
            asset: null,
          },
        ],
      },
    ],
  };
}

it.each([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/vnd.adobe.photoshop",
  "application/zip",
] as const)(
  "continues to parse historical %s records without a workfile binding",
  (mimeType) => {
    const record = historicalRecord(mimeType);
    expect(RetainedOutputSchema.parse(record)).toEqual(record);
  },
);

it("requires a matching work binding only for workfiles and permits selected empty chapters", () => {
  const record = historicalRecord("application/vnd.carrot.mgtshare");
  const binding = {
    workId: "work",
    chapterIds: ["chapter", "empty"],
    snapshot: "0".repeat(16),
  };
  expect(RetainedOutputSchema.safeParse(record).success).toBe(false);
  expect(
    RetainedOutputSchema.parse({ ...record, workFileBinding: binding })
      .workFileBinding,
  ).toEqual(binding);
  for (const workFileBinding of [
    { ...binding, workId: "foreign-work" },
    { ...binding, chapterIds: ["unrelated-chapter"] },
  ])
    expect(
      RetainedOutputSchema.safeParse({ ...record, workFileBinding }).success,
    ).toBe(false);
  expect(
    RetainedOutputSchema.safeParse({
      ...historicalRecord("image/png"),
      workFileBinding: binding,
    }).success,
  ).toBe(false);
});
