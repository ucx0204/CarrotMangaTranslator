import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import connectionModule from "./mcp-test-connection.cjs";

/** @typedef {{type: "text", text: string} | {type: "image", data: string, mimeType: string}} ToolContent */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { readTestConnection } = connectionModule;
const ACCEPT = "application/json, text/event-stream";
let nextId = 1;
let version = "2025-11-25";

/** @param {Response} response */
async function readJson(response) {
  if (!response.body) throw new Error("Empty HTTP response.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("MCP response exceeds the diagnostic limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** @param {{url: string, token: string}} connection @param {unknown} message */
function post(connection, message) {
  return fetch(connection.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      Accept: ACCEPT,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": version,
    },
    body: JSON.stringify(message),
    redirect: "error",
    signal: AbortSignal.timeout(35_000),
  });
}

/** @param {{url: string, token: string}} connection @param {string} method @param {object} [params] */
async function rpc(connection, method, params = {}) {
  const id = nextId++;
  const response = await post(connection, {
    jsonrpc: "2.0",
    id,
    method,
    params,
  });
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status} during ${method}. Check the app, token and exact public origin.`,
    );
  const reply = await readJson(response);
  assert.equal(reply.jsonrpc, "2.0");
  assert.equal(reply.id, id);
  if (reply.error)
    throw new Error(`MCP protocol error ${reply.error.code} during ${method}.`);
  return reply.result;
}

/**
 * @param {{url: string, token: string}} connection
 * @param {string} name
 * @param {object} [args]
 * @returns {Promise<{isError?: boolean, content: ToolContent[]}>}
 */
async function call(connection, name, args = {}) {
  const result = await rpc(connection, "tools/call", { name, arguments: args });
  if (result.isError)
    throw new Error(
      `${name} was rejected by the app. For previews, check local image-redaction policy; do not disable protection for private pages. See the local app log.`,
    );
  return result;
}

/** @param {{content: Array<{type: string, text?: string}>}} result */
function textResult(result) {
  const entry = result.content.find((item) => item.type === "text");
  if (!entry?.text) throw new Error("Missing structured text result.");
  return JSON.parse(entry.text);
}

/** @param {{url: string, token: string}} connection */
async function handshake(connection) {
  const denied = await post(
    { ...connection, token: "intentionally-invalid" },
    { jsonrpc: "2.0", id: 0, method: "ping" },
  );
  assert.equal(denied.status, 401, "Invalid credentials must be rejected");
  await denied.body?.cancel();
  console.log("PASS invalid token rejected (401)");
  const initialized = await rpc(connection, "initialize", {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: "carrot-mcp-smoke", version: "1.0.0" },
  });
  assert.equal(initialized.serverInfo.name, "carrot-manga-translator");
  version = initialized.protocolVersion;
  const notification = await post(connection, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
  console.log(`PASS MCP initialize / notification (${version})`);
}

/** @param {{url: string, token: string}} connection */
async function inspectLibrary(connection) {
  const listing = await rpc(connection, "tools/list");
  console.log(`PASS tools/list (${listing.tools.length} tools)`);
  const capabilities = textResult(
    await call(connection, "carrot_get_capabilities"),
  );
  assert.equal(capabilities.mode, "read-only");
  assert.equal(capabilities.translation, false);
  console.log(
    `PASS capabilities (imageTransfer=${capabilities.imageTransfer})`,
  );
  const works = textResult(
    await call(connection, "carrot_list_works", { limit: 5 }),
  );
  console.log(`PASS library read (${works.total} works)`);
  console.log(JSON.stringify(works.works, null, 2));
  if (!works.works.length) return null;
  const chapters = textResult(
    await call(connection, "carrot_list_chapters", {
      workId: works.works[0].id,
      limit: 1,
    }),
  );
  console.log(`PASS chapters read (${chapters.total} chapters in first work)`);
  if (!chapters.chapters.length) return null;
  const chapterId = chapters.chapters[0].id;
  const chapter = textResult(
    await call(connection, "carrot_get_chapter", { chapterId, limit: 1 }),
  );
  console.log(`PASS pages read (${chapter.total} pages in first chapter)`);
  return chapter.pages.length
    ? { chapterId, pageId: chapter.pages[0].id }
    : null;
}

/** @param {{url: string, token: string}} connection @param {{chapterId: string, pageId: string}} target */
async function savePreview(connection, target) {
  const result = await call(connection, "carrot_get_page_preview", target);
  const image = result.content.find((item) => item.type === "image");
  if (!image)
    throw new Error(
      "Expected an MCP image result. Start mcp-dev.cjs with --images.",
    );
  assert.equal(image.mimeType, "image/png", "Expected an MCP PNG image result");
  const bytes = Buffer.from(image.data, "base64");
  assert.ok(bytes.length <= 4 * 1024 * 1024, "Preview size must be bounded");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const output = join(root, ".tmp", `mcp-preview-${randomUUID()}.png`);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  console.log(`PASS PNG preview saved: ${output}`);
}

function readOptions() {
  const args = process.argv.slice(2);
  if (args.length === 0) return { preview: false, target: null };
  if (args.length === 1 && args[0] === "--first-preview")
    return { preview: true, target: null };
  if (args.length === 3 && args[0] === "--preview")
    return { preview: true, target: { chapterId: args[1], pageId: args[2] } };
  throw new Error(
    "Usage: node scripts/mcp-smoke.mjs [--first-preview | --preview CHAPTER_ID PAGE_ID]",
  );
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: node scripts/mcp-smoke.mjs [--first-preview | --preview CHAPTER_ID PAGE_ID]\nStart mcp-dev.cjs first. Defaults to local port 38475 and .tmp/mcp-local-token.\nOptional env: CARROT_MCP_URL, CARROT_MCP_PORT, CARROT_MCP_TOKEN.\nNo images are downloaded unless explicitly requested. No AI models or writes are invoked.",
    );
    return;
  }
  const options = readOptions();
  const connection = readTestConnection();
  await handshake(connection);
  const first = await inspectLibrary(connection);
  if (options.preview) {
    const target = options.target ?? first;
    if (!target)
      throw new Error(
        "No page found. Add a non-private test image to the development app first.",
      );
    await savePreview(connection, target);
  }
  console.log(
    "PASS smoke test complete (read-only; no OCR or translation executed)",
  );
}

main().catch((error) => {
  console.error(
    "FAIL",
    error instanceof Error ? error.message : "Unknown diagnostic failure",
  );
  console.error(
    "Keep the development app open. Check docs/mcp-testing.md for setup and troubleshooting.",
  );
  process.exitCode = 1;
});
