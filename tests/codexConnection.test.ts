// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { codexConnection } from "../src/renderer/src/api/codexConnection";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { CodexAccountSnapshot } from "../src/shared/codexAccountTypes";
afterEach(() => {
  Reflect.deleteProperty(window, "mangaApi");
  codexConnection.publish(null);
});
it("shares an in-flight account lookup and keeps a newer logout authoritative", async () => {
  let finish!: (value: CodexAccountSnapshot) => void;
  const getCodexAccount = vi.fn(
    () =>
      new Promise<CodexAccountSnapshot>((resolve) => {
        finish = resolve;
      }),
  );
  window.mangaApi = createTestMangaGatewayStub({ getCodexAccount });
  const listener = vi.fn();
  const unsubscribe = codexConnection.subscribe(listener);
  const first = codexConnection.refresh();
  expect(codexConnection.refresh()).toBe(first);
  const revision = codexConnection.getRevision();
  codexConnection.publish(null);
  expect(codexConnection.isChecked()).toBe(true);
  expect(codexConnection.getRevision()).toBe(revision + 1);
  finish({ authenticated: true } as CodexAccountSnapshot);
  expect(await first).toBeNull();
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
  codexConnection.publish(null);
  expect(listener).toHaveBeenCalledOnce();
});
