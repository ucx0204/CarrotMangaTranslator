import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  mcpArtifactName,
  mcpArtifactMime,
  mcpArtifactRequiresImages,
} from "../src/shared/mcpOutputFormats";
import {
  artifactToken,
  collectRetained,
  exchangeRetentionFixture,
} from "./mcpExchangeRetention.fixture";

type Fixture = Awaited<ReturnType<typeof exchangeRetentionFixture>>;

it.each([
  ["txt", "text/plain", "text.txt"],
  ["tsv", "text/tab-separated-values", "review.tsv"],
] as const)(
  "retains and reissues native %s bytes with the canonical filename and source checks",
  async (format, mimeType, filename) => {
    const f = await exchangeRetentionFixture();
    try {
      const output = await publishText(f, format);
      expect(output.published.mimeType).toBe(mimeType);
      expect(mcpArtifactName(mimeType)).toBe(filename);
      expect(mcpArtifactMime(filename)).toBe(mimeType);
      expect(mcpArtifactRequiresImages(mimeType)).toBe(false);
      await f.restart();
      const { issueRetainedOutput, readRetainedOutput, checkOutputPages } =
        await import("../src/main/mcp/mcpRetainedOutputs");
      const { withLibraryRead } = await import("../src/main/library/lock");
      const { record } = await readRetainedOutput(
        f.storage,
        f.owner,
        output.id,
      );
      // Legacy internal callers may omit the extra format callback; saved-source checks remain mandatory.
      await withLibraryRead(() => checkOutputPages(record, true));
      let revoked = false;
      const guard = () => {
        if (revoked) throw new Error("Native caller revoked");
      };
      const renewed = await issueRetainedOutput(
        f.storage,
        f.operations().artifacts,
        f.owner,
        output.id,
        guard,
      );
      expect(renewed.mimeType).toBe(mimeType);
      expect(renewed.url).not.toBe(output.published.url);
      expect(new URL(renewed.url).pathname.endsWith(`/${filename}`)).toBe(true);
      const opened = await f
        .operations()
        .artifacts.open(artifactToken(renewed.url), filename);
      expect(
        (await collectRetained(opened.stream())).equals(output.source.bytes),
      ).toBe(true);
      await expect(
        f
          .operations()
          .artifacts.open(artifactToken(renewed.url), "context.json"),
      ).rejects.toMatchObject({ code: "not_found" });
      const pending = await f
        .operations()
        .artifacts.open(artifactToken(renewed.url), filename);
      revoked = true;
      await expect(collectRetained(pending.stream())).rejects.toThrow(
        "Native caller revoked",
      );
      expect(
        (await f.savedBytes(output.id, renewed.sha256)).equals(
          output.source.bytes,
        ),
      ).toBe(true);
      expect(f.acquireEngine).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

async function publishText(f: Fixture, format: "txt" | "tsv") {
  const { readMcpTextExportSource } =
    await import("../src/main/mcp/mcpTextExportSource");
  const source = await readMcpTextExportSource(
    {
      chapterId: "chapter",
      options:
        format === "txt"
          ? { format, field: "translated", includeHeaders: true }
          : { format, includeBom: true },
    },
    () => {},
  );
  const artifacts = f.operations().artifacts;
  let published: Awaited<ReturnType<typeof artifacts.putExchange>> | undefined;
  const wrap = f.operations().wrapTool;
  if (!wrap) throw new Error("Native retained publisher must be connected");
  const tool = wrap({
    name: "carrot_export_text_file",
    description: "Native retained text export boundary",
    inputSchema: { type: "object" },
    readOnly: true,
    requiredScopes: ["carrot.read"],
    invoke: async () => {
      published = await artifacts.putExchange(
        source.bytes,
        source.binding,
        source.verifySources,
        new AbortController().signal,
      );
      return [];
    },
  });
  await tool.invoke({ requestId: randomUUID() }, f.auth());
  if (!published?.retainedOutputId)
    throw new Error("Expected owned durable text output");
  return { source, published, id: published.retainedOutputId };
}
