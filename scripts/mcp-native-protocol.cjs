const assert = require("node:assert/strict");

/** Real HTTP against compiled Electron composition, without a session or initialize call.
 * @param {string} url @param {string} token */
async function checkNativeModernProtocol(url, token) {
  const version = "2026-07-28";
  /** @param {string} method @param {Record<string,unknown>} [params] */
  const send = (method, params = {}) =>
    fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": version,
        "Mcp-Method": method,
        ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "native-modern",
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": version,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "carrot-native",
              version: "1",
            },
          },
        },
      }),
    });
  const discovery = await send("server/discover");
  assert.equal(discovery.status, 200);
  const discovered = (await discovery.json()).result;
  assert.equal(discovered.resultType, "complete");
  assert.ok(discovered.supportedVersions.includes(version));
  assert.equal(
    discovered._meta["io.modelcontextprotocol/serverInfo"].name,
    "carrot-manga-translator",
  );
  const capabilities = await send("tools/call", {
    name: "carrot_get_capabilities",
    arguments: {},
  });
  assert.equal(capabilities.status, 200);
  const result = (await capabilities.json()).result;
  assert.equal(result.resultType, "complete");
  assert.equal(result.isError, false);
  assert.deepEqual(
    result.structuredContent,
    JSON.parse(result.content[0].text),
  );
  assert.equal((await send("initialize")).status, 404);
  console.log(
    "PASS native 2026 stateless discovery and schema-validated structured tool results",
  );
}
module.exports = { checkNativeModernProtocol };
