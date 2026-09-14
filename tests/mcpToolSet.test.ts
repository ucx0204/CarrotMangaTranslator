import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { it } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { readMcpConfiguration } from "../src/main/mcp/mcpConfiguration";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";
import { invokeMcpTool } from "../src/main/mcp/mcpReadTools";
import { createMcpToolSet } from "../src/main/mcp/mcpToolSet";

const exec = promisify(execFile);
const token = "b".repeat(43);
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=";

function libraryPort() {
  const chapter: ChapterSnapshot = {
    id: "chapter",
    workId: "work",
    title: "Test chapter",
    sourceKind: "images",
    status: "idle",
    pageOrder: ["page"],
    createdAt: "now",
    updatedAt: "now",
    pages: [
      {
        id: "page",
        name: "test.png",
        imagePath: "/private/test.png",
        dataUrl: "PRIVATE",
        width: 1,
        height: 1,
        blocks: [],
        analysisStatus: "idle",
        createdAt: "now",
        updatedAt: "now",
      },
    ],
  };
  return {
    openChapter: async () => chapter,
    listLibrary: async () => ({
      workOrder: ["work"],
      works: [
        {
          id: "work",
          title: "Test work",
          chapterOrder: ["chapter"],
          createdAt: "now",
          updatedAt: "now",
          chapters: [
            {
              id: "chapter",
              workId: "work",
              title: chapter.title,
              status: chapter.status,
              pageCount: 1,
              createdAt: "now",
              updatedAt: "now",
            },
          ],
        },
      ],
    }),
  };
}

it("requires an explicit image-transfer flag and rejects misspelled values", () => {
  const env = { CARROT_MCP_ENABLED: "1", CARROT_MCP_TOKEN: token };
  assert.equal(readMcpConfiguration(env)?.allowImages, false);
  assert.equal(
    readMcpConfiguration({ ...env, CARROT_MCP_ALLOW_IMAGES: "1" })?.allowImages,
    true,
  );
  assert.throws(() =>
    readMcpConfiguration({ ...env, CARROT_MCP_ALLOW_IMAGES: "true" }),
  );
});

it("keeps advertised capabilities aligned with actually registered image tools", async () => {
  for (const enabled of [false, true]) {
    const tools = createMcpToolSet(
      libraryPort(),
      enabled ? async () => ({ data: png, width: 1, height: 1 }) : undefined,
    );
    assert.equal(tools.length, enabled ? 5 : 4);
    assert.equal(
      tools.some((tool) => tool.name === "carrot_get_page_preview"),
      enabled,
    );
    const capabilities = await invokeMcpTool(tools[0], {});
    assert.equal(capabilities[0].type, "text");
    if (capabilities[0].type !== "text") throw new Error("Missing text");
    assert.equal(JSON.parse(capabilities[0].text).imageTransfer, enabled);
  }
});

it("runs the user diagnostic script against real HTTP and saves a bounded PNG", async () => {
  const failures: unknown[] = [];
  const server = await startMcpHttpServer({
    config: { port: 0, token },
    tools: createMcpToolSet(libraryPort(), async () => ({
      data: png,
      width: 1,
      height: 1,
    })),
    reportError: (error) => failures.push(error),
  });
  let preview: string | undefined;
  try {
    const { stdout } = await exec(
      process.execPath,
      ["scripts/mcp-smoke.mjs", "--first-preview"],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          CARROT_MCP_TOKEN: token,
          CARROT_MCP_URL: server.url,
        },
        timeout: 12_000,
        maxBuffer: 1024 * 1024,
      },
    );
    preview = stdout.match(/PASS PNG preview saved: ([^\r\n]+)/)?.[1];
    assert.ok(preview);
    assert.equal((await readFile(preview)).toString("base64"), png);
    assert.ok(stdout.includes("PASS invalid token rejected (401)"));
    assert.ok(stdout.includes("PASS smoke test complete"));
    assert.deepEqual(failures, []);
  } finally {
    await server.close();
    if (preview) await rm(preview, { force: true });
  }
});

it("checks metadata successfully without downloading images on the default connection", async () => {
  const server = await startMcpHttpServer({
    config: { port: 0, token },
    tools: createMcpToolSet(libraryPort()),
    reportError: (error) => {
      throw error;
    },
  });
  try {
    const { stdout } = await exec(process.execPath, ["scripts/mcp-smoke.mjs"], {
      env: {
        ...process.env,
        CARROT_MCP_TOKEN: token,
        CARROT_MCP_URL: server.url,
      },
      timeout: 12_000,
    });
    assert.ok(stdout.includes("imageTransfer=false"));
    assert.ok(stdout.includes("PASS smoke test complete"));
    assert.equal(stdout.includes("PNG preview saved"), false);
  } finally {
    await server.close();
  }
});
