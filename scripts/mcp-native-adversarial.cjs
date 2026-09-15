const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
/** @param {string} root @param {string} name */
const load = (root, name) => require(join(root, "out", name));
/** @param {string} root @param {Array<any>} tools */
async function fixture(root, tools) {
  const { startMcpHttpServer } = load(root, "main/mcp/mcpHttpServer.js");
  const { McpOAuthProvider } = load(root, "main/mcp/mcpOAuthProvider.js");
  const { McpOAuthSession } = load(root, "main/mcp/mcpOAuthSession.js");
  const { McpOAuthHttp } = load(root, "main/mcp/mcpOAuthHttp.js");
  const { McpPairingBroker } = load(root, "main/mcp/mcpPairingBroker.js");
  const { oauthDigest } = load(root, "main/mcp/mcpOAuthPolicy.js");
  const origin = "https://adversarial.tail-test.ts.net",
    secret = "s".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowImages: true,
    allowEdits: true,
    allowProcessing: true,
  });
  const session = new McpOAuthSession(provider, { save: async () => {} });
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools,
    enforceScopes: true,
    oauthHttp: new McpOAuthHttp(origin, secret, {
      session,
      pairing: new McpPairingBroker(provider, secret),
    }),
    reportError: (/** @type {unknown} */ error) => console.error(error),
  });
  /** @param {string} scope */
  const mint = (scope) => {
    const callback = "https://chatgpt.com/connector/oauth/native-adversarial";
    const client = provider.register({
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
    });
    const pending = provider.begin({
      client_id: client.client_id,
      response_type: "code",
      redirect_uri: callback,
      resource: origin + "/mcp",
      scope,
      state: "fixture",
      code_challenge_method: "S256",
      code_challenge: oauthDigest(secret),
    });
    const redirect = new URL(
      provider.approve(
        {
          transaction: pending.transaction,
          pairing_secret: secret,
          decision: "approve",
        },
        pending.cookie,
      ),
    );
    return provider.token({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: callback,
      resource: origin + "/mcp",
      code: redirect.searchParams.get("code"),
      code_verifier: secret,
    }).access_token;
  };
  /** @param {string} token @param {string} name @param {unknown} args */
  const call = async (token, name, args) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  return {
    server,
    call,
    full: mint("carrot.read carrot.edit carrot.images carrot.process"),
    read: mint("carrot.read"),
  };
}
/** @param {unknown} value */
function rejected(value) {
  assert.ok(value && typeof value === "object");
  assert.ok(
    ("error" in value && value.error) ||
      ("result" in value &&
        value.result &&
        typeof value.result === "object" &&
        "isError" in value.result &&
        value.result.isError),
    "Invalid request unexpectedly succeeded: " + JSON.stringify(value),
  );
}
/** Real tools and real library behind isolated HTTP authorization. Never the user's running server.
 * @param {string} root @param {Array<any>} tools @param {string} chapterId @param {string} pageId */
async function checkNativeAdversarial(root, tools, chapterId, pageId) {
  const library = load(root, "main/library.js");
  const { createPageRevision } = load(root, "shared/pageRevision.js");
  const before = await library.openChapter(chapterId);
  const page = before.pages.find(
    (/** @type {{id:string}} */ item) => item.id === pageId,
  );
  assert.ok(page);
  const f = await fixture(root, tools);
  let checks = 0;
  try {
    for (const tool of tools) {
      for (const args of [
        null,
        [],
        7,
        "text",
        { unexpected: true },
        JSON.parse('{"__proto__":{"polluted":true}}'),
      ]) {
        rejected(await f.call(f.full, tool.name, args));
        checks++;
      }
      if (
        (tool.requiredScopes ?? ["carrot.read"]).some(
          (/** @type {string} */ scope) => scope !== "carrot.read",
        )
      ) {
        rejected(await f.call(f.read, tool.name, {}));
        checks++;
      }
    }
    const target = { chapterId, pageId, revision: createPageRevision(page) };
    for (const edits of [
      [{ blockId: "absent", translatedText: "changed" }],
      [
        { blockId: page.blocks[0].id, translatedText: "changed" },
        { blockId: page.blocks[0].id, translatedText: "changed" },
      ],
    ]) {
      rejected(
        await f.call(f.full, "carrot_update_translations", {
          ...target,
          edits,
        }),
      );
      checks++;
    }
    for (const blockIds of [
      [],
      [page.blocks[0].id, page.blocks[0].id],
      ["absent"],
    ]) {
      rejected(
        await f.call(f.full, "carrot_set_page_reading_order", {
          ...target,
          blockIds,
        }),
      );
      checks++;
    }
    for (const fields of [
      { fontSizePx: -1 },
      { textOpacity: 2 },
      { rotationDeg: 181 },
      { sourceText: "x".repeat(20001) },
      { generatedLettering: { dataUrl: "private" } },
    ]) {
      rejected(
        await f.call(f.full, "carrot_update_page_blocks", {
          ...target,
          edits: [{ blockId: page.blocks[0].id, fields }],
        }),
      );
      checks++;
    }
    rejected(
      await f.call(f.full, "carrot_create_page_blocks", {
        ...target,
        requestId: randomUUID(),
        blocks: [
          {
            key: "invalid",
            sourceText: "x",
            translatedText: "y",
            sourceRect: { x: page.width, y: page.height, w: 1, h: 1 },
          },
        ],
      }),
    );
    checks++;
    assert.deepEqual(
      await library.openChapter(chapterId),
      before,
      "Rejected inputs changed saved data",
    );
    const unicode =
      "\uD55C\uAE00 \u65E5\u672C\u8A9E \uD83D\uDE00 <script>text only</script>\nline two";
    const changed = await f.call(f.full, "carrot_update_translations", {
      ...target,
      edits: [{ blockId: page.blocks[0].id, translatedText: unicode }],
    });
    assert.equal(changed.result.isError, false);
    const readback = await library.openChapter(chapterId);
    assert.equal(
      readback.pages.find(
        (/** @type {{id:string}} */ item) => item.id === pageId,
      ).blocks[0].translatedText,
      unicode,
    );
    const restored = await f.call(f.full, "carrot_update_translations", {
      chapterId,
      pageId,
      revision: changed.result.structuredContent.revision,
      edits: changed.result.structuredContent.previousTranslations,
    });
    assert.equal(restored.result.isError, false);
    checks += 2;
    console.log(
      `PASS native hostile HTTP matrix: ${checks} checks across ${tools.length} production tools; Unicode roundtrip and original data preserved`,
    );
  } finally {
    await f.server.close();
  }
}
module.exports = { checkNativeAdversarial };
