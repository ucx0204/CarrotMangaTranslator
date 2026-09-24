import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import { psdCaptureFixture } from "./mcpPsdExport.fixture";
import { renderMcpPsdInSession } from "../src/main/mcp/mcpPsdExport";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpRetentionOutputs } from "../src/shared/mcpRetention";

it("reissues the same retained native PSD bytes after reconstruction and blocks corruption, foreign access and disposal", async () => {
  const f = await retentionFixture();
  try {
    const before = await readFile(f.chapterPath);
    const page = (await f.snapshot()).pages[0];
    const original = await readFile(page.imagePath);
    const capture = psdCaptureFixture(page);
    const bytes = await renderMcpPsdInSession(page, capture.session);
    const artifacts = f.operations().artifacts;
    const wrap = f.operations().wrapTool;
    if (!wrap) throw new Error("Native retention must be connected");
    let output: { url: string; retainedOutputId?: string } | undefined;
    const tool = wrap({
      name: "carrot_export_pages_psd",
      description: "Native PSD assembler with deterministic renderer boundary",
      inputSchema: { type: "object" },
      readOnly: true,
      requiredScopes: ["carrot.read", "carrot.images"],
      invoke: async () => {
        output = await artifacts.putImage(bytes, "psd", async () => {}, {
          chapterId: "chapter",
          pageId: page.id,
          revision: createPageRevision(page),
        });
        return [];
      },
    });
    await tool.invoke({ requestId: randomUUID() }, f.auth());
    if (!output?.retainedOutputId)
      throw new Error("Missing retained PSD output");
    const id = output.retainedOutputId;
    const renderCount = capture.session.renderPage.mock.calls.length;
    await f.restart();
    await expect(
      artifacts.read(new URL(output.url).pathname.split("/")[2]),
    ).rejects.toThrow();
    const issued = mcpRetentionOutputs.carrot_get_output_file.parse(
      (await f.invoke("carrot_get_output_file", { id })).structuredContent,
    );
    expect(issued.mimeType).toBe("image/vnd.adobe.photoshop");
    expect(
      await f
        .operations()
        .artifacts.read(new URL(issued.url).pathname.split("/")[2]),
    ).toEqual(bytes);
    expect(capture.session.renderPage).toHaveBeenCalledTimes(renderCount);
    await expect(
      f.invoke("carrot_get_output_file", { id }, f.auth("foreign")),
    ).rejects.toThrow();
    const path = await f.storage.path(id, issued.sha256);
    const corrupted = Buffer.from(bytes);
    corrupted[0] ^= 1;
    await writeFile(path, corrupted);
    await expect(f.invoke("carrot_get_output", { id })).rejects.toThrow();
    await writeFile(path, bytes);
    await f.invoke("carrot_discard_retained", { id, confirm: true });
    await expect(
      f.operations().artifacts.read(new URL(issued.url).pathname.split("/")[2]),
    ).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(await readFile(page.imagePath)).toEqual(original);
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
