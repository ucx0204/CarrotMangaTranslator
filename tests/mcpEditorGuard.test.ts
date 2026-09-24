import { afterEach, expect, it, vi } from "vitest";
import { McpEditorGuard } from "../src/main/application/mcpEditorGuard";
import { mcpIpcContracts } from "../src/shared/ipcMcpContracts";

const chapterId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const pageId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const clean = {
  chapterId,
  dirtyPageIds: [] as string[],
  hasPendingInpaintingMask: false,
};
afterEach(() => {
  vi.useRealTimers();
});
it("requests a fresh renderer response for every check, with no heartbeat dependency", async () => {
  const ids: number[] = [];
  const guard = new McpEditorGuard(
    () => false,
    (id) => ids.push(id),
  );
  const first = guard.assertWritable(chapterId, pageId);
  guard.report({ ...clean, probeId: ids[0] });
  await first;
  const second = guard.assertWritable(chapterId, pageId);
  expect(ids).toHaveLength(2);
  expect(ids[1]).not.toBe(ids[0]);
  guard.report({ ...clean, probeId: ids[1] });
  await second;
});
it("refuses stale, missing or mismatched probe IDs and times out closed", async () => {
  vi.useFakeTimers();
  const probe = vi.fn();
  const guard = new McpEditorGuard(() => false, probe);
  const check = expect(
    guard.assertWritable(chapterId, pageId),
  ).rejects.toMatchObject({ code: "editor_busy" });
  guard.report({ ...clean });
  guard.report({ ...clean, probeId: 999 });
  await vi.advanceTimersByTimeAsync(5000);
  await check;
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects local dirty pages and pending mask changes, but not another chapter", async () => {
  let reported = { ...clean };
  const guard = new McpEditorGuard(
    () => false,
    (id) => guard.report({ ...reported, probeId: id }),
  );
  reported = { ...clean, dirtyPageIds: [pageId] };
  await expect(guard.assertWritable(chapterId, pageId)).rejects.toMatchObject({
    code: "editor_busy",
  });
  reported = { ...clean, hasPendingInpaintingMask: true };
  await expect(guard.assertWritable(chapterId, pageId)).rejects.toMatchObject({
    code: "editor_busy",
  });
  await expect(
    guard.assertWritable("another-chapter", pageId),
  ).resolves.toBeUndefined();
});
it("rejects a job running before or starting during the renderer check", async () => {
  let busy = true;
  const request = vi.fn((id: number) => {
    busy = true;
    guard.report({ ...clean, probeId: id });
  });
  const guard = new McpEditorGuard(() => busy, request);
  await expect(guard.assertWritable(chapterId, pageId)).rejects.toMatchObject({
    code: "editor_busy",
  });
  expect(request).not.toHaveBeenCalled();
  busy = false;
  await expect(guard.assertWritable(chapterId, pageId)).rejects.toMatchObject({
    code: "editor_busy",
  });
});
it("cleans up a failed renderer request and bounds concurrent probes", async () => {
  vi.useFakeTimers();
  const failed = new McpEditorGuard(
    () => false,
    () => {
      throw new Error("closed window");
    },
  );
  await expect(failed.assertWritable(chapterId, pageId)).rejects.toMatchObject({
    code: "editor_busy",
  });
  expect(vi.getTimerCount()).toBe(0);
  const guard = new McpEditorGuard(
    () => false,
    () => {},
  );
  const checks = Array.from({ length: 8 }, () =>
    expect(guard.assertWritable(chapterId, pageId)).rejects.toMatchObject({
      code: "editor_busy",
    }),
  );
  await expect(guard.assertWritable(chapterId, pageId)).rejects.toThrow(
    /Too many/,
  );
  await vi.advanceTimersByTimeAsync(5000);
  await Promise.all(checks);
  expect(vi.getTimerCount()).toBe(0);
});
it("accepts the nonce on the real trusted IPC schema and rejects extra fields", () => {
  const args = mcpIpcContracts.reportMcpEditorState.args;
  expect(args.safeParse([{ ...clean, probeId: 1 }]).success).toBe(true);
  expect(args.safeParse([{ ...clean, probeId: -1 }]).success).toBe(false);
  expect(
    args.safeParse([{ ...clean, probeId: 1, approve: true }]).success,
  ).toBe(false);
});
