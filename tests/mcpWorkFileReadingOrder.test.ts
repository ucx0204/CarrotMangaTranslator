import { expect, it } from "vitest";
import { buildMaterializedSharedPage } from "../src/main/libraryStore/shareImportPageRecord";
import { resolvePageBlockOrder } from "../src/shared/blockReadingOrder";
import { editingChapter } from "./mcpEditing.fixture";

it("preserves explicit work-file reading order after regenerating block identities", () => {
  const page = structuredClone(editingChapter().pages[0]);
  expect(page.blocks.length).toBeGreaterThanOrEqual(2);
  page.blockOrder = page.blocks.map((block) => block.id).reverse();
  const before = structuredClone(page);
  const materialized = buildMaterializedSharedPage({
    packagePage: page,
    pageId: "destination",
    imagePath: "destination.png",
    width: page.width,
    height: page.height,
    now: "2026-09-22T00:00:00.000Z",
  });
  const expected = page.blockOrder.map(
    (id) =>
      `destination-block-${page.blocks.findIndex((block) => block.id === id) + 1}`,
  );
  expect(materialized.blockOrder).toEqual(expected);
  expect(resolvePageBlockOrder(materialized)).toEqual(expected);
  expect(page).toEqual(before);
});

it("does not invent a fixed reading order for a work-file page without one", () => {
  const page = structuredClone(editingChapter().pages[0]);
  delete page.blockOrder;
  const result = buildMaterializedSharedPage({
    packagePage: page,
    pageId: "destination",
    imagePath: "destination.png",
    width: page.width,
    height: page.height,
    now: "2026-09-22T00:00:00.000Z",
  });
  expect(result.blockOrder).toBeUndefined();
});
