import { describe, expect, it } from "vitest";
import { editingChapter } from "./mcpEditing.fixture";
import {
  buildReviewRows,
  parseReviewDocument,
  parseReviewTable,
  serializeReviewRows,
} from "../src/shared/reviewTable";
import { planReviewImport } from "../src/shared/reviewImportPlan";

function fixture() {
  const chapter = editingChapter();
  const rows = buildReviewRows(chapter, "ltr");
  const row = rows.find((row) => row.block_id === "a");
  const block = chapter.pages[0].blocks.find((block) => block.id === "a");
  if (!row || !block)
    throw new Error("Expected the original native review row and block.");
  return { chapter, row, block };
}
describe("canonical native review row plan", () => {
  it("is pure, preserves unrelated payloads and carries native literal text fields", () => {
    const f = fixture();
    const before = structuredClone(f.chapter);
    const row = {
      ...f.row,
      translated_text: " literal\r\ntext\t ",
      review_note: " note\n",
      review_status: "reviewed",
    };
    const plan = planReviewImport(f.chapter, [row], {});
    expect(f.chapter).toEqual(before);
    expect(plan.updatedBlockCount).toBe(1);
    expect(plan.rows[0].after).toEqual({
      ...f.block,
      translatedText: row.translated_text,
      reviewNote: row.review_note,
      reviewStatus: "reviewed",
    });
    expect(plan.rows[0].before).toBe(f.block);
    expect(plan.diagnostics).toEqual([]);
  });
  it("preserves optional absence when an empty review note is otherwise unchanged", () => {
    const f = fixture();
    const plan = planReviewImport(f.chapter, [f.row], {});
    expect(plan.rows[0].result).toBe("unchanged");
    expect(plan.rows[0].after).toBe(f.block);
    expect(plan.rows[0].after).not.toHaveProperty("reviewNote");
  });
  it("keeps invalid status while applying other allowed fields", () => {
    const f = fixture();
    const plan = planReviewImport(
      f.chapter,
      [{ ...f.row, review_status: "not-a-status", translated_text: "new" }],
      {},
    );
    expect(plan.rows[0].after).not.toHaveProperty("reviewStatus");
    expect(plan.rows[0].after?.translatedText).toBe("new");
    expect(plan.diagnostics).toEqual([
      {
        key: "reviewImport.warnings.invalidStatus",
        values: { row: 2, status: "not-a-status" },
      },
    ]);
  });
  it.each(["", "missing"])("skips unresolved block id %s", (blockId) => {
    const f = fixture();
    const plan = planReviewImport(
      f.chapter,
      [{ ...f.row, block_id: blockId }],
      {},
    );
    expect(plan.skippedRowCount).toBe(1);
    expect(plan.updatedBlockCount).toBe(0);
    expect(plan.rows[0].after).toBeNull();
  });
  it("retains native unique-ID fallback and diagnostic order", () => {
    const f = fixture();
    const plan = planReviewImport(
      f.chapter,
      [{ ...f.row, page_id: "missing", translated_text: "new" }],
      {},
    );
    expect(plan.rows[0]).toMatchObject({
      pageId: "page",
      blockId: "a",
      result: "updated",
    });
    expect(plan.diagnostics.map((item) => item.key)).toEqual([
      "reviewImport.warnings.pageNotFound",
      "reviewImport.warnings.pageMismatch",
    ]);
  });
  it.each(["chapter", "source"])(
    "claims the first target before failed %s validation",
    (failure) => {
      const f = fixture();
      const first =
        failure === "chapter"
          ? { ...f.row, chapter_id: "foreign" }
          : { ...f.row, source_text: "mismatch" };
      const plan = planReviewImport(
        f.chapter,
        [first, { ...f.row, translated_text: "must remain skipped" }],
        { requireSourceMatch: true },
      );
      expect(plan.rows.map((row) => row.result)).toEqual([
        "skipped",
        "skipped",
      ]);
      expect(plan.diagnostics.at(-1)?.key).toBe(
        "reviewImport.warnings.duplicateBlockId",
      );
    },
  );
  it("normalizes BOM, newline and NFC only for source comparison", () => {
    const f = fixture();
    f.block.sourceText = "가\r\nsource";
    const source = "\uFEFF\u1100\u1161\nsource";
    const plan = planReviewImport(
      f.chapter,
      [{ ...f.row, source_text: source, translated_text: "new" }],
      { requireSourceMatch: true, updateSourceText: true },
    );
    expect(plan.diagnostics).toEqual([]);
    expect(plan.rows[0].after?.sourceText).toBe(source);
  });
  it("retains native empty-source comparison bypass and explicit source update", () => {
    const f = fixture();
    const plan = planReviewImport(
      f.chapter,
      [{ ...f.row, source_text: "", translated_text: "new" }],
      { requireSourceMatch: true, updateSourceText: true },
    );
    expect(plan.rows[0].after?.sourceText).toBe("");
    expect(plan.diagnostics).toEqual([]);
  });
  it("uses scoped IDs for duplicated block IDs and refuses ambiguous global fallback", () => {
    const f = fixture();
    const other = structuredClone(f.chapter.pages[0]);
    other.id = "second";
    f.chapter.pages.push(other);
    const scoped = planReviewImport(
      f.chapter,
      [{ ...f.row, page_id: "second", translated_text: "new" }],
      {},
    );
    expect(scoped.rows[0].pageId).toBe("second");
    const ambiguous = planReviewImport(
      f.chapter,
      [{ ...f.row, page_id: "" }],
      {},
    );
    expect(ambiguous.rows[0].result).toBe("skipped");
    expect(ambiguous.diagnostics[0].key).toBe(
      "reviewImport.warnings.ambiguousBlock",
    );
  });
});

describe("review table source projection", () => {
  it.each(["csv", "tsv"] as const)(
    "keeps original page indices and literal %s bytes for a subset",
    (format) => {
      const f = fixture();
      const second = structuredClone(f.chapter.pages[0]);
      second.id = "second";
      second.name = "quoted,\tname.png";
      second.blocks[0].reviewNote = '"quotes"\r\nline';
      f.chapter.pages.push(second);
      f.chapter.pageOrder.push(second.id);
      const rows = buildReviewRows(f.chapter, "ltr", new Set(["second"]));
      const whole = buildReviewRows(f.chapter, "ltr").filter(
        (row) => row.page_id === "second",
      );
      expect(rows).toEqual(whole);
      expect(rows.every((row) => row.page_index === "1")).toBe(true);
      const bytes = serializeReviewRows(rows, format, true);
      expect(bytes.startsWith("\uFEFFchapter_id")).toBe(true);
      expect(bytes.endsWith("\r\n")).toBe(true);
      expect(parseReviewTable(bytes, format)).toEqual(rows);
    },
  );
  it("reports ignored/duplicate headers while preserving the native row projection", () => {
    const f = fixture();
    const csv = serializeReviewRows([f.row], "csv", false);
    const content = csv.replace(
      "review_note\r\n",
      "review_note,fontFamily,review_note\r\n",
    );
    const result = parseReviewDocument(content, "csv");
    expect(result.ignoredColumns).toEqual(["fontFamily"]);
    expect(result.duplicateColumns).toEqual(["review_note"]);
    expect(result.rows).toEqual(parseReviewTable(content, "csv"));
  });
});
