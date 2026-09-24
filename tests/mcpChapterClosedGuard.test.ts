import { afterEach, expect, it, vi } from "vitest";
import { McpEditorGuard } from "../src/main/application/mcpEditorGuard";

const chapterId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
afterEach(() => vi.useRealTimers());

it("refuses an open chapter even with no dirty pages and permits an unrelated or closed editor", async () => {
  let open: string | null = chapterId;
  const guard = new McpEditorGuard(
    () => false,
    (probeId) => {
      guard.report({
        probeId,
        chapterId: open,
        dirtyPageIds: [],
        hasPendingInpaintingMask: false,
      });
    },
  );
  await expect(guard.assertChapterClosed(chapterId)).rejects.toMatchObject({
    code: "editor_busy",
  });
  open = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  await expect(guard.assertChapterClosed(chapterId)).resolves.toBeUndefined();
  open = null;
  await expect(guard.assertChapterClosed(chapterId)).resolves.toBeUndefined();
});

it("requires a new matching trusted probe rather than a previous closed response", async () => {
  vi.useFakeTimers();
  const ids: number[] = [];
  const guard = new McpEditorGuard(
    () => false,
    (id) => ids.push(id),
  );
  const report = (probeId: number) =>
    guard.report({
      probeId,
      chapterId: null,
      dirtyPageIds: [],
      hasPendingInpaintingMask: false,
    });
  const first = guard.assertChapterClosed(chapterId);
  report(ids[0]);
  await first;
  const second = expect(
    guard.assertChapterClosed(chapterId),
  ).rejects.toMatchObject({ code: "editor_busy" });
  report(ids[0]);
  await vi.advanceTimersByTimeAsync(5000);
  await second;
  expect(ids).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});
