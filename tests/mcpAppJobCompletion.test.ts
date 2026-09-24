import { describe, expect, it, vi } from "vitest";
import { runMcpAppJob } from "../src/main/mcp/mcpAppJob";
import { makeContext } from "./inpaintingSelectionJobFixtures";

vi.mock("electron", () => ({ app: { isPackaged: false }, nativeImage: {} }));

describe("MCP native completion projection", () => {
  it.each([
    ["completed", "completed"],
    ["partial", "failed"],
    ["failed", "failed"],
    ["interrupted", "failed"],
    ["cancelled", "cancelled"],
  ] as const)(
    "publishes %s as native %s while preserving its returned outcome",
    async (status, expected) => {
      const app = makeContext(vi.fn());
      const events = vi.spyOn(app.jobs, "updateLastEvent");
      const controller = new AbortController();
      const result = { status, publishedBytes: status === "partial" ? 23 : 0 };
      expect(
        await runMcpAppJob(
          app,
          {
            id: "completion",
            signal: controller.signal,
            assertAuthorized: () => undefined,
            progress: () => undefined,
          },
          "page-export",
          async () => result,
          {
            resources: [],
            completionStatus: (value) =>
              value.status === "completed"
                ? "completed"
                : value.status === "cancelled"
                  ? "cancelled"
                  : "failed",
          },
        ),
      ).toBe(result);
      expect(events.mock.calls.at(-1)?.[1].status).toBe(expected);
      expect(app.jobs.all).toEqual([]);
    },
  );

  it("keeps the established completion behavior when no result projection is supplied", async () => {
    const app = makeContext(vi.fn());
    const events = vi.spyOn(app.jobs, "updateLastEvent");
    await runMcpAppJob(
      app,
      {
        id: "legacy",
        signal: new AbortController().signal,
        assertAuthorized: () => undefined,
        progress: () => undefined,
      },
      "page-export",
      async () => ({ status: "partial" }),
      { resources: [] },
    );
    expect(events.mock.calls.at(-1)?.[1].status).toBe("completed");
  });
});
