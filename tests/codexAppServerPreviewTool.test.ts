import { describe, expect, it, vi } from "vitest";
import { CodexAppServerPreviewHost } from "../src/main/codexAppServerPreviewTool";
import { buildCodexAppServerArguments } from "../src/main/codexAppServerPolicy";

const success = {
  success: true,
  contentItems: [{ type: "inputText" as const, text: "preview" }],
};
function message(callId: string, input: unknown = { x: 1 }) {
  return {
    id: callId,
    method: "item/tool/call",
    params: {
      threadId: "registered",
      turnId: "turn",
      tool: "preview_erasure",
      callId,
      arguments: input,
    },
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("scoped erasure preview host", () => {
  it("refuses to replace an owned registration and preserves its original tool", async () => {
    const host = new CodexAppServerPreviewHost(),
      reply = vi.fn();
    const execute = vi.fn(async () => success),
      replacement = vi.fn();
    host.register("registered", { inputSchema: {}, execute });
    expect(() =>
      host.register("registered", { inputSchema: {}, execute: replacement }),
    ).toThrow("already registered");
    host.dispatch(message("first"), reply);
    await flush();
    expect(execute).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
  });

  it("returns a non-Error failure without opening a second execution", async () => {
    const host = new CodexAppServerPreviewHost(),
      reply = vi.fn();
    const execute = vi.fn().mockRejectedValue("storage unavailable");
    host.register("registered", { inputSchema: {}, execute });
    host.dispatch(message("first"), reply);
    await flush();
    expect(reply.mock.calls[0][0].result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "storage unavailable" }],
    });
    host.dispatch(message("second"), reply);
    await flush();
    expect(execute).toHaveBeenCalledOnce();
    expect(reply.mock.calls[1][0].result.success).toBe(false);
  });

  it("rejects a second proposal even while the first is pending", async () => {
    const host = new CodexAppServerPreviewHost(),
      reply = vi.fn();
    let finish!: (value: typeof success) => void;
    const execute = vi.fn(
      () =>
        new Promise<typeof success>((resolve) => {
          finish = resolve;
        }),
    );
    host.register("registered", { inputSchema: {}, execute });
    host.dispatch(message("first"), reply);
    host.dispatch(message("concurrent"), reply);
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: expect.stringContaining("Single-preview budget"),
            },
          ],
        }),
      }),
    );
    finish(success);
    await flush();
    expect(reply).toHaveBeenCalledTimes(2);
  });
  it("replays duplicate requests once and rejects changed input under a reused ID", async () => {
    const host = new CodexAppServerPreviewHost();
    const execute = vi.fn(async () => success),
      reply = vi.fn();
    host.register("registered", { inputSchema: {}, execute });
    host.dispatch(message("a"), reply);
    host.dispatch(message("a"), reply);
    host.dispatch(message("a", { x: 2 }), reply);
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      reply.mock.calls.filter(([value]) => value.result.success),
    ).toHaveLength(2);
    expect(
      reply.mock.calls.find(([value]) => !value.result.success)?.[0].result,
    ).toMatchObject({
      contentItems: [{ text: expect.stringContaining("different input") }],
    });
  });

  it("allows one attempt and surfaces renderer failure without retry", async () => {
    const host = new CodexAppServerPreviewHost();
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("invalid mask"))
      .mockResolvedValue(success);
    const reply = vi.fn();
    host.register("registered", { inputSchema: {}, execute });
    for (const id of ["a", "b", "c", "d"]) {
      host.dispatch(message(id), reply);
      await flush();
    }
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0].result).toMatchObject({
      success: false,
      contentItems: [{ text: "invalid mask" }],
    });
    expect(reply.mock.calls[3][0].result).toMatchObject({
      contentItems: [{ text: expect.stringContaining("budget") }],
    });
  });

  it("rejects unrelated tools, namespaces and threads without calling the renderer", () => {
    const host = new CodexAppServerPreviewHost(),
      execute = vi.fn();
    host.register("registered", { inputSchema: {}, execute });
    const original = message("a");
    for (const params of [
      { threadId: "other" },
      { tool: "shell" },
      { namespace: "other" },
      { callId: 2 },
    ])
      expect(
        host.dispatch(
          { ...original, params: { ...original.params, ...params } },
          vi.fn(),
        ),
      ).toBe(false);
    expect(
      host.dispatch(
        { ...original, method: "item/fileChange/requestApproval" },
        vi.fn(),
      ),
    ).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("stops cancelled work and never replies from a disposed pending renderer", async () => {
    const host = new CodexAppServerPreviewHost(),
      controller = new AbortController();
    let finish!: (value: typeof success) => void;
    const execute = vi.fn(
      () =>
        new Promise<typeof success>((resolve) => {
          finish = resolve;
        }),
    );
    const reply = vi.fn(),
      dispose = host.register(
        "registered",
        { inputSchema: {}, execute },
        controller.signal,
      );
    host.dispatch(message("a"), reply);
    await flush();
    dispose();
    finish(success);
    await flush();
    expect(reply).not.toHaveBeenCalled();
    host.register(
      "registered",
      { inputSchema: {}, execute },
      controller.signal,
    );
    controller.abort();
    host.dispatch(message("b"), reply);
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ success: false }),
      }),
    );
    host.clear();
    expect(host.dispatch(message("c"), reply)).toBe(false);
  });

  it("enables only code mode for previews while existing isolated policy stays disabled", () => {
    for (const capability of ["isolated", "typesetting-preview"] as const) {
      const args = buildCodexAppServerArguments(capability);
      for (const name of ["code_mode", "code_mode_host"])
        expect(
          args.some(
            (arg, i) =>
              arg === (capability === "isolated" ? "--disable" : "--enable") &&
              args[i + 1] === name,
          ),
        ).toBe(true);
      for (const name of [
        "shell_tool",
        "unified_exec",
        "image_generation",
        "multi_agent",
        "apps",
        "plugins",
      ])
        expect(
          args.some((arg, i) => arg === "--disable" && args[i + 1] === name),
        ).toBe(true);
      expect(args).toContain('web_search="disabled"');
    }
  });
});
