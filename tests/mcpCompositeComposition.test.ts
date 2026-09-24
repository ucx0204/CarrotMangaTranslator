import { expect, it } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";

it("binds composite native dispatch once to the actual final app tools and fails closed beforehand", async () => {
  const f = await retentionFixture();
  try {
    await expect(f.invoke("carrot_list_composites", {})).rejects.toMatchObject({
      code: "access_denied",
    });
    const { createMcpAppTools } = await import("../src/main/mcp/mcpAppTools");
    const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
    const { mcpCompositeWorkflowOutputs } =
      await import("../src/shared/mcpCompositeWorkflowOutputs");
    const session = f.operations();
    const bind = session.bindNativeTools;
    if (!bind) throw new Error("Expected native composite composition binder");
    let received: readonly unknown[] | undefined;
    const tools = createMcpAppTools({
      ...f.editing,
      preferences: {
        allowEditing: true,
        allowProcessing: true,
        allowImages: true,
        autoStart: false,
      },
      additionalTools: session.tools,
      wrapTool: session.wrapTool,
      bindNativeTools: (actual) => {
        received = actual;
        bind(actual);
      },
    });
    expect(received).toBe(tools);
    expect(
      tools.filter((tool) => tool.name === "carrot_render_page_preview"),
    ).toHaveLength(1);
    for (const name of Object.keys(mcpCompositeWorkflowOutputs))
      expect(tools.filter((tool) => tool.name === name)).toHaveLength(1);
    const list = tools.find((tool) => tool.name === "carrot_list_composites");
    if (!list) throw new Error("Missing composite list tool");
    const response = mcpToolResult(list, await list.invoke({}, f.auth()));
    expect(
      mcpCompositeWorkflowOutputs.carrot_list_composites.parse(
        response.structuredContent,
      ),
    ).toMatchObject({ total: 0, items: [] });
    expect(() => bind(tools)).toThrow("exactly once");
    session.stop();
    await expect(list.invoke({}, f.auth())).rejects.toMatchObject({
      code: "access_denied",
    });
  } finally {
    await f.close();
  }
});
