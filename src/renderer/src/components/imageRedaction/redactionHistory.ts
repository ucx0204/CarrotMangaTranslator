import type { RedactionDocument } from "../../../../shared/imageRedactionWorkspace";

type DocumentMap = Record<string, RedactionDocument>;
export type RedactionEdit = {
  before: DocumentMap;
  after: DocumentMap;
  batch: boolean;
  estimatedBytes: number;
};
const PER_SCOPE_LIMIT = 100;
const TOTAL_ENTRY_LIMIT = 10000;
const ESTIMATED_BYTES_LIMIT = 32 * 1024 * 1024;
const documentCosts = new WeakMap<RedactionDocument, number>();

/** Bound each stack by page/batch scope and estimated payload, not just page count. */
export function retainRedactionHistory(
  entries: RedactionEdit[],
): RedactionEdit[] {
  const counts = new Map<string, number>();
  const retained: RedactionEdit[] = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const edit = entries[index];
    const scope = edit.batch ? "batch" : `page:${Object.keys(edit.after)[0]}`;
    const count = counts.get(scope) ?? 0;
    if (count >= PER_SCOPE_LIMIT) continue;
    if (
      retained.length >= TOTAL_ENTRY_LIMIT ||
      bytes + edit.estimatedBytes > ESTIMATED_BYTES_LIMIT
    )
      break;
    retained.push(edit);
    counts.set(scope, count + 1);
    bytes += edit.estimatedBytes;
  }
  return retained.reverse();
}

export function createRedactionEdit(
  before: DocumentMap,
  after: DocumentMap,
  batch: boolean,
): RedactionEdit {
  return {
    before,
    after,
    batch: batch || Object.keys(after).length > 1,
    estimatedBytes: [...Object.values(before), ...Object.values(after)].reduce(
      (total, document) => total + documentCost(document),
      128,
    ),
  };
}

function documentCost(document: RedactionDocument): number {
  const cached = documentCosts.get(document);
  if (cached !== undefined) return cached;
  // A conservative logical payload estimate, not a measurement of the JS heap.
  const bytes = document.strokes.reduce(
    (total, stroke) =>
      total +
      64 +
      stroke.points.length * 32 +
      (stroke.isolation?.length ?? 0) * 8,
    128 + (document.id.length + document.fingerprint.length) * 2,
  );
  documentCosts.set(document, bytes);
  return bytes;
}
