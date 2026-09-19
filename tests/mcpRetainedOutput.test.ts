import { randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpRetentionOutputs } from "../src/shared/mcpRetention";

const token = (url: string) => new URL(url).pathname.split("/")[2];

/** Deterministic renderer boundary; native retention, ZIP, encryption and tools are real. */
async function outputFixture() {
  const f = await retentionFixture();
  const publish = async (zip = false, supplied?: Buffer) => {
    const page = (await f.snapshot()).pages[0];
    const bytes = supplied ?? (await readFile(page.imagePath));
    const artifacts = f.operations().artifacts;
    const wrap = f.operations().wrapTool;
    if (!wrap) throw new Error("Retention must be connected");
    let output: { url: string; retainedOutputId?: string } | undefined;
    const tool = wrap({
      name: "test_renderer_boundary",
      description: "Deterministic bytes instead of the external renderer",
      inputSchema: { type: "object" },
      readOnly: false,
      requiredScopes: ["carrot.read", "carrot.images"],
      invoke: async () => {
        const png = await artifacts.put(bytes, async () => {}, {
          chapterId: "chapter",
          pageId: page.id,
          revision: createPageRevision(page),
        });
        output = zip
          ? await artifacts.zip(
              [{ url: png.url, filename: "001.png" }],
              { pages: [page.id] },
              async () => {},
              new AbortController().signal,
            )
          : png;
        return [];
      },
    });
    await tool.invoke({ requestId: randomUUID() }, f.auth());
    if (!output?.retainedOutputId) throw new Error("Output was not retained");
    return { id: output.retainedOutputId, url: output.url, bytes };
  };
  const inspect = async (id: string) =>
    mcpRetentionOutputs.carrot_get_output.parse(
      (await f.invoke("carrot_get_output", { id })).structuredContent,
    );
  const issue = async (id: string, caller = f.auth()) =>
    mcpRetentionOutputs.carrot_get_output_file.parse(
      (await f.invoke("carrot_get_output_file", { id }, caller)).structuredContent,
    );
  return { ...f, publish, inspectOutput: inspect, issue };
}

it("retains identical PNG and native ZIP bytes after session closure and issues new capabilities without rendering", async () => {
  const f = await outputFixture();
  try {
    const original = await readFile(f.chapterPath);
    const png = await f.publish();
    const zip = await f.publish(true);
    const old = f.operations().artifacts;
    const archive = await old.read(token(zip.url));
    expect((await f.list("outputs")).total).toBe(3);
    await f.restart();
    await expect(old.read(token(png.url))).rejects.toThrow();
    for (const [output, expected] of [[png, png.bytes], [zip, archive]] as const) {
      expect((await f.inspectOutput(output.id)).canDownload).toBe(true);
      const issued = await f.issue(output.id);
      expect(issued.url).not.toBe(output.url);
      expect(await f.operations().artifacts.read(token(issued.url))).toEqual(expected);
      expect(JSON.stringify(issued)).not.toContain(f.env.root);
    }
    expect(await readFile(f.chapterPath)).toEqual(original);
    expect(f.acquireEngine).not.toHaveBeenCalled();
    expect((await f.list("outputs")).total).toBe(3);
  } finally {
    await f.close();
  }
});

it("refuses missing and same-size altered output bytes during inspection as well as link issuance", async () => {
  const f = await outputFixture();
  try {
    const output = await f.publish();
    const metadata = await f.inspectOutput(output.id);
    if (!metadata.sha256) throw new Error("Expected output hash");
    const path = await f.storage.path(output.id, metadata.sha256);
    const corrupted = Buffer.from(output.bytes);
    corrupted[corrupted.length - 1] ^= 1;
    await writeFile(path, corrupted);
    await expect(f.inspectOutput(output.id)).rejects.toThrow();
    await expect(f.issue(output.id)).rejects.toThrow();
    await rm(path);
    await expect(f.inspectOutput(output.id)).rejects.toThrow();
    await expect(f.issue(output.id)).rejects.toThrow();
    expect((await f.list("outputs")).total).toBe(1);
  } finally {
    await f.close();
  }
});

it("scopes inspection, issue and discard to the owner and never removes originals when a retained record is discarded", async () => {
  const f = await outputFixture();
  try {
    const output = await f.publish();
    const before = await readFile(f.chapterPath);
    const foreign = f.auth("unrelated-connection");
    for (const name of ["carrot_get_output", "carrot_get_output_file", "carrot_discard_retained"]) {
      await expect(f.invoke(name, name.includes("discard") ? { id: output.id, confirm: true } : { id: output.id }, foreign)).rejects.toThrow();
    }
    const file = await f.issue(output.id);
    await expect(f.invoke("carrot_discard_retained", { id: output.id, confirm: false })).rejects.toThrow();
    await f.invoke("carrot_discard_retained", { id: output.id, confirm: true });
    await expect(f.operations().artifacts.read(token(file.url))).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(before);
    const page = (await f.snapshot()).pages[0];
    expect(await readFile(page.imagePath)).toEqual(output.bytes);
  } finally {
    await f.close();
  }
});

it("rejects changed source bytes and page content before reissuing a historical file", async () => {
  const f = await outputFixture();
  try {
    const output = await f.publish();
    const page = (await f.snapshot()).pages[0];
    const changed = Buffer.from(output.bytes);
    changed[changed.length - 1] ^= 1;
    await writeFile(page.imagePath, changed);
    await expect(f.issue(output.id)).rejects.toThrow();
    await writeFile(page.imagePath, output.bytes);
    await f.edit("new current revision");
    await expect(f.issue(output.id)).rejects.toThrow();
    expect((await f.list("outputs")).items[0].id).toBe(output.id);
  } finally {
    await f.close();
  }
});
