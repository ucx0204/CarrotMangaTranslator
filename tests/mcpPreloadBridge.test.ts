import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createContractInvoker } from "../src/preload/ipcContracts";
import { createMangaApi } from "../src/preload/mangaApi";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { mcpGateway } from "../src/renderer/src/api/mcpGateway";

const chapterId = "11111111-1111-4111-8111-111111111111";
const pageId = "22222222-2222-4222-8222-222222222222";
afterEach(() => vi.unstubAllGlobals());

function bridge() {
  const events = new EventEmitter();
  const invoke = vi.fn(async () => ({ completed: true }));
  const warn = vi.fn();
  const api = createMangaApi({
    invoke: createContractInvoker({ invoke }),
    events,
    getPathForFile: () => "",
    warn,
  });
  return { api, events, invoke, warn };
}

it("validates and unsubscribes both MCP editor events at the real preload boundary", () => {
  const { api, events, warn } = bridge();
  const probe = vi.fn();
  const changed = vi.fn();
  const offProbe = api.onMcpEditorProbe(probe);
  const offChanged = api.onMcpPageChanged(changed);
  events.emit("mcp:editor-probe", {}, { id: 7 });
  events.emit("mcp:page-changed", {}, { chapterId, pageIds: [pageId] });
  expect(probe).toHaveBeenCalledExactlyOnceWith({ id: 7 });
  expect(changed).toHaveBeenCalledExactlyOnceWith({
    chapterId,
    pageIds: [pageId],
  });
  events.emit("mcp:editor-probe", {}, { id: -1 });
  events.emit("mcp:editor-probe", {}, { id: 8, extra: true });
  events.emit("mcp:page-changed", {}, { chapterId, pageIds: [] });
  events.emit("mcp:page-changed", {}, {
    chapterId: "../private",
    pageIds: [pageId],
  });
  expect(warn).toHaveBeenCalledTimes(4);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledTimes(1);
  offProbe();
  offChanged();
  expect(events.listenerCount("mcp:editor-probe")).toBe(0);
  expect(events.listenerCount("mcp:page-changed")).toBe(0);
  events.emit("mcp:editor-probe", {}, { id: 9 });
  expect(probe).toHaveBeenCalledTimes(1);
});

it("routes a typed dirty-editor report through the domain gateway and validates before IPC", async () => {
  const { api, invoke } = bridge();
  vi.stubGlobal("window", { mangaApi: api });
  const state = {
    probeId: 4,
    chapterId,
    dirtyPageIds: [pageId],
    hasPendingInpaintingMask: true,
  };
  await expect(mcpGateway.reportMcpEditorState(state)).resolves.toEqual({
    completed: true,
  });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("mcp:editor-state", state);
  expect(() =>
    mcpGateway.reportMcpEditorState({ ...state, probeId: -1 }),
  ).toThrow();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("keeps test-only MCP editor defaults inert without synthesizing a real connection", async () => {
  const api = createTestMangaGatewayStub();
  const listener = vi.fn();
  expect(api.onMcpEditorProbe(listener)()).toBeUndefined();
  expect(api.onMcpPageChanged(listener)()).toBeUndefined();
  await expect(
    api.reportMcpEditorState({
      chapterId: null,
      dirtyPageIds: [],
      hasPendingInpaintingMask: false,
    }),
  ).resolves.toEqual({ completed: true });
  expect(listener).not.toHaveBeenCalled();
  await expect(api.getMcpStatus()).rejects.toThrow(/getMcpStatus/);
});
