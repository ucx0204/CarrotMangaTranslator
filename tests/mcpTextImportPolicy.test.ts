import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translationBatchFixture } from "./mcpTranslationBatch.fixture";
import { editingChapter } from "./mcpEditing.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import { gatherText, formatGatheredText } from "../src/shared/gatherText";
import {
  buildReviewRows,
  serializeReviewRows,
} from "../src/shared/reviewTable";
import { McpTextImportPreviewSchema } from "../src/shared/mcpTextExchange";
import {
  createMcpTextImportPolicy,
  type McpTextImportSourcePort,
} from "../src/main/application/mcpTextImportPolicy";
import { applyMcpTextImportSnapshots } from "../src/main/application/mcpReviewImportPolicy";

const fixtures: ReturnType<typeof translationBatchFixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.service.close();
});
function fixture(format: "txt" | "csv" | "tsv" = "csv") {
  const f = translationBatchFixture();
  fixtures.push(f);
  const value = {
    source: {
      kind: "text",
      workId: "work",
      chapterId: "chapter",
      pages: f.chapter.pages.map((page) => ({
        pageId: page.id,
        revision: createPageRevision(page),
      })),
      options:
        format === "txt"
          ? { format, field: "both", includeHeaders: true }
          : { format, includeBom: true },
      direction: "rtl",
      snapshot: "a".repeat(16),
    },
    uploadId: randomUUID(),
    sha256: "b".repeat(64),
    contextRevision: mcpContextRevision(f.saved),
    requestId: randomUUID(),
    reason: "Apply reviewed offline corrections",
    selection: [{ pageId: "page", blockIds: ["a"] }],
  };
  let content = "";
  const verify = vi.fn(async () => {});
  const guard = vi.fn();
  const checkSource = vi.fn(async () => {});
  const sources: McpTextImportSourcePort = {
    use: async (_owner, input, access, consume, signal) => {
      signal?.throwIfAborted();
      access();
      return consume({
        content,
        verify,
        info: {
          uploadId: input.uploadId,
          sha256: input.sha256,
          format: input.format,
          sourceBytes: Buffer.byteLength(content),
          utf8Bytes: Buffer.byteLength(content),
          decoding: "native-utf8-then-windows-949",
        },
      });
    },
  };
  const policy = createMcpTextImportPolicy(sources, checkSource);
  const request = () => McpTextImportPreviewSchema.parse(value);
  return {
    ...f,
    value,
    request,
    policy,
    verify,
    guard,
    checkSource,
    rows: () => buildReviewRows(f.chapter, "rtl"),
    setContent: (text: string) => {
      content = text;
    },
    plan: (input: unknown = request()) =>
      policy.plan(f.saved, policy.parse(input), { owner: "owner", guard }),
  };
}

describe("reviewed text import admission", () => {
  it.each(["", "foreign"])(
    "never applies a CSV row with chapter_id=%s",
    async (chapterId) => {
      const f = fixture();
      const row = f
        .rows()
        .find((row) => row.page_id === "page" && row.block_id === "a");
      if (!row) throw new Error("Expected the selected fixture row.");
      f.setContent(
        serializeReviewRows(
          [
            {
              ...row,
              chapter_id: chapterId,
              translated_text: "must not apply",
            },
          ],
          "csv",
        ),
      );
      const plan = await f.plan();
      expect(plan.pages[0].changedBlocks).toBe(0);
      expect(
        plan.diagnostics.some(
          (item) => item.code === "row_outside_explicit_selection",
        ),
      ).toBe(true);
    },
  );
  it.each(["second", "missing", ""])(
    "cannot use native global-ID fallback as authority for page_id=%s",
    async (pageId) => {
      const f = fixture();
      const row = f
        .rows()
        .find((row) => row.page_id === "page" && row.block_id === "a");
      if (!row) throw new Error("Expected the selected fixture row.");
      f.setContent(
        serializeReviewRows(
          [{ ...row, page_id: pageId, translated_text: "must not apply" }],
          "csv",
        ),
      );
      const plan = await f.plan();
      expect(plan.pages[0].changes[0].changed).toBe(false);
    },
  );
  it("applies only selected IDs and exposes only four scalar fields", async () => {
    const f = fixture();
    const before = structuredClone(f.chapter);
    f.setContent(
      serializeReviewRows(
        f.rows().map((row) => ({
          ...row,
          translated_text: "edited",
          review_status: "reviewed",
          review_note: "literal\n note",
        })),
        "csv",
      ),
    );
    const plan = await f.plan();
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0].changedBlocks).toBe(1);
    expect(plan.pages[0].changes[0].after).toEqual({
      sourceText: "source",
      translatedText: "edited",
      reviewStatus: "reviewed",
      reviewNote: "literal\n note",
    });
    expect(JSON.stringify(plan)).not.toMatch(
      /PRIVATE|imagePath|fontFamily|renderBbox/,
    );
    expect(f.chapter).toEqual(before);
    expect(f.checkSource).toHaveBeenCalledWith(
      f.request().source,
      f.guard,
      undefined,
    );
    expect(f.verify).toHaveBeenCalled();
  });
  it("reports extra columns and rejects duplicate headers without silently choosing one", async () => {
    const f = fixture();
    const rows = f.rows();
    const csv = serializeReviewRows(rows, "csv");
    f.setContent(csv.replace("review_note\r\n", "review_note,fontFamily\r\n"));
    expect((await f.plan()).diagnostics).toContainEqual({
      code: "unsupported_column_ignored",
      field: "fontFamily",
    });
    f.setContent(
      csv.replace("review_note\r\n", "review_note,translated_text\r\n"),
    );
    await expect(f.plan()).rejects.toMatchObject({ code: "invalid_edit" });
  });
  it("requires explicit source editing and clearing approval", async () => {
    const f = fixture();
    const row = f
      .rows()
      .find((row) => row.page_id === "page" && row.block_id === "a");
    if (!row) throw new Error("Expected the selected fixture row.");
    f.setContent(
      serializeReviewRows(
        [{ ...row, source_text: "", translated_text: "" }],
        "csv",
      ),
    );
    await expect(f.plan()).rejects.toMatchObject({ code: "invalid_edit" });
    const plan = await f.plan({
      ...f.request(),
      allowEmpty: true,
      updateSourceText: true,
    });
    expect(plan.pages[0].changes[0].after).toMatchObject({
      sourceText: "",
      translatedText: "",
    });
  });
  it("keeps native generated lettering while warning that only review text fields change", async () => {
    const f = fixture();
    f.chapter.pages[0].blocks[0].generatedLettering =
      editingChapter().pages[0].blocks[0].generatedLettering;
    f.value.source.pages[0].revision = createPageRevision(f.chapter.pages[0]);
    f.setContent(
      serializeReviewRows(
        f.rows().map((row) => ({ ...row, translated_text: "changed" })),
        "csv",
      ),
    );
    const plan = await f.plan();
    const change = plan.pages[0].changes[0];
    expect(change.changed).toBe(true);
    expect(change.warnings).toContain(
      "generated_lettering_image_preserved_text_fields_only",
    );
    expect(JSON.stringify(plan)).not.toContain("PRIVATE-GENERATED");
  });
  it("rejects oversized cells and distinct-target violations without clipping", async () => {
    const f = fixture();
    const row = f.rows()[0];
    f.setContent(
      serializeReviewRows(
        [{ ...row, block_id: "a", translated_text: "x".repeat(20001) }],
        "csv",
      ),
    );
    await expect(f.plan()).rejects.toMatchObject({ code: "invalid_edit" });
    f.setContent(serializeReviewRows(f.rows(), "csv"));
    await expect(
      f.plan({
        ...f.request(),
        selection: [{ pageId: "page", blockIds: ["a", "a"] }],
      }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
  });
  it("rejects changed page and context revisions before preparing any changes", async () => {
    const f = fixture();
    f.setContent(serializeReviewRows(f.rows(), "csv"));
    const request = f.request();
    f.chapter.pages[0].blocks[0].translatedText = "newer user edit";
    await expect(f.plan(request)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    await expect(
      f.plan({ ...f.request(), contextRevision: "0".repeat(16) }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });
});

describe("native TXT mapping through the existing translation policy", () => {
  it("resolves native order then applies only selected blocks and reports other file updates", async () => {
    const f = fixture("txt");
    const gathered = gatherText({
      chapter: f.chapter,
      page: null,
      scope: "chapter",
      direction: "rtl",
    });
    f.setContent(
      formatGatheredText(gathered, "both").replaceAll("original-a", "reviewed"),
    );
    const plan = await f.plan();
    expect(plan.pages[0].changes[0].after.translatedText).toBe("reviewed");
    expect(
      plan.diagnostics.filter(
        (item) => item.code === "unselected_txt_update_ignored",
      ),
    ).toHaveLength(2);
    expect(plan.pages[0].changes[0].before.translatedText).toBe("original-a");
  });
  it("excludes generated lettering using the existing policy", async () => {
    const f = fixture("txt");
    f.chapter.pages[0].blocks[0].generatedLettering =
      editingChapter().pages[0].blocks[0].generatedLettering;
    f.value.source.pages[0].revision = createPageRevision(f.chapter.pages[0]);
    f.setContent(
      formatGatheredText(
        gatherText({ chapter: f.chapter, page: null, scope: "chapter" }),
        "both",
      ).replaceAll("original-a", "new"),
    );
    const change = (await f.plan()).pages[0].changes[0];
    expect(change.excludedReason).toBe("generated_lettering");
    expect(change.changed).toBe(false);
  });
  it("rejects repeated mapped updates and source-only TXT intent", async () => {
    const f = fixture("txt");
    const gathered = gatherText({
      chapter: f.chapter,
      page: f.chapter.pages[0],
      scope: "page",
    });
    const text = formatGatheredText(gathered, "both").replace(
      "original-a",
      "new",
    );
    f.setContent(`${text}\n\n${text}`);
    await expect(f.plan()).rejects.toMatchObject({ code: "invalid_edit" });
    const input = f.request();
    expect(
      McpTextImportPreviewSchema.safeParse({
        ...input,
        source: {
          ...input.source,
          options: { format: "txt", field: "source", includeHeaders: true },
        },
      }).success,
    ).toBe(false);
  });
});

it("applies and restores four-field optional state while preserving all other page/block data", async () => {
  const f = fixture();
  f.setContent(
    serializeReviewRows(
      f.rows().map((row) => ({
        ...row,
        translated_text: "new",
        review_note: "note",
      })),
      "csv",
    ),
  );
  const input = f.policy.parse(f.request());
  const plan = await f.plan();
  const page = f.chapter.pages[0];
  const apply = f.policy.request(plan.pages[0], input, "apply", plan);
  if (apply.kind !== "review")
    throw new Error("Expected native review request");
  const blocks = applyMcpTextImportSnapshots(page, apply);
  expect(blocks[1]).toBe(page.blocks[1]);
  expect(blocks[0]).toEqual({
    ...page.blocks[0],
    translatedText: "new",
    reviewNote: "note",
  });
  const undo = f.policy.request(plan.pages[0], input, "undo", plan);
  if (undo.kind !== "review")
    throw new Error("Expected native review undo request");
  expect(applyMcpTextImportSnapshots({ ...page, blocks }, undo)).toEqual(
    page.blocks,
  );
  expect(() =>
    applyMcpTextImportSnapshots({ ...page, name: "renamed.png" }, apply),
  ).toThrow(/page name changed/);
});
