import type { ChapterSnapshot } from "./libraryTypes";
import { sortBlocksForReading } from "./blockReadingOrder";

const REVIEW_COLUMNS = [
  "chapter_id",
  "page_id",
  "page_index",
  "page_name",
  "block_id",
  "block_order",
  "source_text",
  "translated_text",
  "review_status",
  "review_note",
] as const;

type ReviewColumn = (typeof REVIEW_COLUMNS)[number];

export type ReviewRow = Record<ReviewColumn, string>;

const BOM = "\uFEFF";

export function buildReviewRows(
  chapter: ChapterSnapshot,
  direction: "ltr" | "rtl" = "rtl",
): ReviewRow[] {
  const rows: ReviewRow[] = [];
  for (const [pageIndex, page] of chapter.pages.entries()) {
    const orderedBlocks = sortBlocksForReading(page.blocks, direction);
    for (const [blockIndex, block] of orderedBlocks.entries()) {
      rows.push({
        chapter_id: chapter.id,
        page_id: page.id,
        page_index: String(pageIndex),
        page_name: page.name,
        block_id: block.id,
        block_order: String(blockIndex),
        source_text: block.sourceText,
        translated_text: block.translatedText,
        review_status: block.reviewStatus ?? "",
        review_note: block.reviewNote ?? "",
      });
    }
  }
  return rows;
}

export function serializeReviewRows(
  rows: ReviewRow[],
  format: "csv" | "tsv",
  includeBom = true,
): string {
  const delimiter = format === "tsv" ? "\t" : ",";
  const lines = [
    REVIEW_COLUMNS.join(delimiter),
    ...rows.map((row) =>
      REVIEW_COLUMNS.map((column) =>
        escapeDelimitedCell(row[column], delimiter),
      ).join(delimiter),
    ),
  ];
  return `${includeBom ? BOM : ""}${lines.join("\r\n")}\r\n`;
}

export function parseReviewTable(
  content: string,
  format: "csv" | "tsv" | "auto",
): ReviewRow[] {
  const normalizedContent = stripBom(content);
  const delimiter =
    format === "auto"
      ? detectDelimiter(normalizedContent)
      : resolveDelimiter(format);
  const records = parseDelimitedRecords(normalizedContent, delimiter);
  if (records.length === 0) {
    return [];
  }

  const header = records[0]?.map((cell) => cell.trim()) ?? [];
  assertRequiredColumns(header);
  const columnIndex = new Map(header.map((column, index) => [column, index]));

  return records.slice(1).flatMap((record) => {
    if (record.every((cell) => cell.trim() === "")) {
      return [];
    }
    const row = Object.fromEntries(
      REVIEW_COLUMNS.map((column) => [
        column,
        record[columnIndex.get(column) ?? -1] ?? "",
      ]),
    );
    return [row as ReviewRow];
  });
}

function escapeDelimitedCell(value: string, delimiter: string): string {
  if (
    value.includes('"') ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.includes(delimiter)
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function stripBom(content: string): string {
  return content.startsWith(BOM) ? content.slice(1) : content;
}

function detectDelimiter(content: string): "," | "\t" {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
}

function resolveDelimiter(format: "csv" | "tsv"): "," | "\t" {
  return format === "tsv" ? "\t" : ",";
}

function parseDelimitedRecords(
  content: string,
  delimiter: "," | "\t",
): string[][] {
  const state: DelimitedParserState = {
    records: [],
    record: [],
    cell: "",
    inQuotes: false,
  };

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    index = state.inQuotes
      ? consumeQuotedCharacter(state, char, next, index)
      : consumeUnquotedCharacter(state, char, next, delimiter, index);
  }

  if (state.inQuotes) {
    throw new Error("검수표 CSV/TSV 따옴표가 닫히지 않았습니다.");
  }
  if (state.cell || state.record.length > 0) {
    finishRecord(state);
  }
  return state.records;
}

type DelimitedParserState = {
  records: string[][];
  record: string[];
  cell: string;
  inQuotes: boolean;
};

function consumeQuotedCharacter(
  state: DelimitedParserState,
  char: string,
  next: string | undefined,
  index: number,
): number {
  if (char !== '"') {
    state.cell += char;
    return index;
  }
  if (next === '"') {
    state.cell += '"';
    return index + 1;
  }
  state.inQuotes = false;
  return index;
}

function consumeUnquotedCharacter(
  state: DelimitedParserState,
  char: string,
  next: string | undefined,
  delimiter: "," | "\t",
  index: number,
): number {
  if (char === '"') {
    state.inQuotes = true;
  } else if (char === delimiter) {
    finishCell(state);
  } else if (char === "\r" || char === "\n") {
    finishRecord(state);
    return char === "\r" && next === "\n" ? index + 1 : index;
  } else {
    state.cell += char;
  }
  return index;
}

function finishCell(state: DelimitedParserState): void {
  state.record.push(state.cell);
  state.cell = "";
}

function finishRecord(state: DelimitedParserState): void {
  finishCell(state);
  state.records.push(state.record);
  state.record = [];
}

function assertRequiredColumns(header: string[]): void {
  const missingColumns = REVIEW_COLUMNS.filter(
    (column) => !header.includes(column),
  );
  if (missingColumns.length > 0) {
    throw new Error(
      `검수표 필수 컬럼이 없습니다: ${missingColumns.join(", ")}`,
    );
  }
}
