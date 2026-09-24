const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

/** Production OS encryption and atomic persistence in the caller-owned isolated root.
 * @param {string} root */
function jobPersistence(root) {
  const { McpSecureStore } = require(
    join(root, "out/main/mcp/mcpSecureStore.js"),
  );
  const store = new McpSecureStore(root);
  return {
    load: () => store.readJobJournal(),
    save: (/** @type {unknown} */ snapshot) => store.writeJobJournal(snapshot),
  };
}

/** @param {string} root @param {string} jobId @param {string} expiredUrl */
async function checkNativeJobHistory(root, jobId, expiredUrl) {
  const { McpOperationService } = require(
    join(root, "out/main/application/mcpOperationService.js"),
  );
  const { createMcpOperationTools } = require(
    join(root, "out/main/mcp/mcpOperationTools.js"),
  );
  const { mcpToolResult } = require(
    join(root, "out/main/mcp/mcpToolResult.js"),
  );
  const service = new McpOperationService(
    (/** @type {unknown} */ error) => {
      throw error;
    },
    Date.now,
    jobPersistence(root),
  );
  try {
    await service.ready();
    const tools = createMcpOperationTools(service, {});
    const tool = tools.find(
      (/** @type {{name:string}} */ item) => item.name === "carrot_list_jobs",
    );
    assert.ok(tool);
    const context = {
      principalId: "native-fixture",
      assertAuthorized: () => {},
    };
    const result = mcpToolResult(tool, await tool.invoke({}, context));
    assert.equal(result.isError, false);
    const receipt = result.structuredContent.jobs.find(
      (/** @type {{jobId:string}} */ item) => item.jobId === jobId,
    );
    assert.ok(receipt);
    assert.equal(receipt.persistence, "durable");
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.result.artifactExpired, true);
    assert.equal(receipt.result.url, undefined);
    assert.equal(receipt.result.kind, "rendered-page-png");
    assert.deepEqual(service.list("other-client", 0, 100).jobs, []);
    assert.throws(() => service.status(jobId, "other-client"));
    const encrypted = await readFile(
      join(root, "mcp-private/jobs.enc"),
      "utf8",
    );
    assert.equal(encrypted.includes(jobId), false);
    const plaintext = JSON.stringify(await jobPersistence(root).load());
    assert.equal(plaintext.includes(expiredUrl), false);
    assert.equal(plaintext.includes(root), false);
    console.log(
      "PASS native encrypted job history restores without execution or expired file capabilities",
    );
  } finally {
    await service.close();
  }
}

module.exports = { jobPersistence, checkNativeJobHistory };
