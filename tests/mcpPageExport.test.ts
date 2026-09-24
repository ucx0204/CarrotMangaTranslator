import { describe, expect, it, vi } from "vitest";
import { McpPageExportService } from "../src/main/application/mcpPageExportService";
import { McpArtifactStore } from "../src/main/mcp/mcpArtifactStore";
import { createPageRevision } from "../src/shared/pageRevision";
import { editingChapter } from "./mcpEditing.fixture";

function fixture() {
  const chapter = editingChapter();
  let allowed = true;
  const store = new McpArtifactStore("https://carrot.example.ts.net");
  const assertImageAccess = vi.fn(async () => {});
  const render = vi.fn(async () => Buffer.from("rendered-png"));
  const service = new McpPageExportService({
    openChapter: async () => structuredClone(chapter),
    render,
    store: store.put.bind(store),
    assertImageAccess,
  });
  const context = {
    id: "export",
    signal: new AbortController().signal,
    progress: vi.fn(),
    assertAuthorized: () => {
      if (!allowed) throw new Error("revoked");
    },
  };
  const target = {
    chapterId: "chapter",
    pageId: "page",
    revision: createPageRevision(chapter.pages[0]),
  };
  return {
    chapter,
    store,
    render,
    assertImageAccess,
    service,
    context,
    target,
    revoke: () => {
      allowed = false;
    },
  };
}
describe("MCP original-size output", () => {
  it("uses the saved page renderer and returns a scoped link, not local paths", async () => {
    const f = fixture();
    try {
      const result = await f.service.export(f.target, f.context);
      expect(f.render).toHaveBeenCalledWith(
        f.chapter.pages[0],
        f.context.signal,
      );
      expect(result).toMatchObject({
        kind: "rendered-page-png",
        width: 1000,
        height: 1600,
        performed: ["render", "export"],
      });
      expect(JSON.stringify(result)).not.toMatch(/private|PRIVATE/);
      expect(
        await f.store.read(new URL(result.url).pathname.split("/")[2]),
      ).toEqual(Buffer.from("rendered-png"));
    } finally {
      await f.store.close();
    }
  });
  it.each(["revision", "redaction", "revocation"])(
    "revalidates %s when an exported PNG is fetched",
    async (change) => {
      const f = fixture();
      try {
        const result = await f.service.export(f.target, f.context);
        if (change === "revision")
          f.chapter.pages[0].blocks[0].translatedText = "changed";
        if (change === "redaction")
          f.assertImageAccess.mockRejectedValue(new Error("redaction"));
        if (change === "revocation") f.revoke();
        await expect(
          f.store.read(new URL(result.url).pathname.split("/")[2]),
        ).rejects.toThrow();
      } finally {
        await f.store.close();
      }
    },
  );
  it("does not publish a page changed during rendering", async () => {
    const f = fixture();
    f.render.mockImplementationOnce(async () => {
      f.chapter.pages[0].blocks[0].translatedText = "new";
      return Buffer.from("stale");
    });
    try {
      await expect(f.service.export(f.target, f.context)).rejects.toMatchObject(
        { code: "revision_conflict" },
      );
    } finally {
      await f.store.close();
    }
  });
});
