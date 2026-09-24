const assert = require("node:assert/strict");
const { download } = require("./mcp-native-export-batch.cjs");
const {
  exchangeNativeClient,
  exchangeArtifactHttp,
  observeExchangeWork,
  completeExchangeResponse,
} = require("./mcp-native-exchange-client.cjs");
const {
  assertExchangeHead,
  assertSafeDelivery,
} = require("./mcp-native-exchange-export.cjs");
const {
  assertExchangeOriginals,
} = require("./mcp-native-exchange-fixture.cjs");
const { exchangeLinkStatus } = require("./mcp-native-exchange-import.cjs");

/** @typedef {import("./mcp-native-exchange-client.cjs").NativeApp} NativeApp */
/** @typedef {import("./mcp-native-exchange-client.cjs").Editing} Editing */
/** @typedef {import("./mcp-native-exchange-client.cjs").Client} Client */
/** @typedef {import("./mcp-native-exchange-fixture.cjs").Fixture} Fixture */
/** @typedef {import("./mcp-native-exchange-export.cjs").Exported} Exported */

/** Reconstructed session, registered owner checks, native retention and real loopback HTTP.
 * @param {string} root @param {NativeApp} app @param {Editing} editing
 * @param {Fixture} source @param {Exported[]} outputs */
async function checkNativeDelivery(root, app, editing, source, outputs) {
  assert.equal(app.appPaths.dataRoot, root);
  const observed = observeExchangeWork(app);
  /** @type {Client | undefined} */
  let activeClient;
  /** @type {Awaited<ReturnType<typeof exchangeArtifactHttp>> | undefined} */
  let activeHttp;
  /** @type {{url:string,id:string,jobId:string}[]} */
  const links = [];
  try {
    const client = await exchangeNativeClient(root, app, editing);
    activeClient = client;
    const http = await exchangeArtifactHttp(root, client);
    activeHttp = http;
    const beforeJobs = await client.call("list_jobs", {});
    for (const output of outputs) {
      assert.equal(await exchangeLinkStatus(http.origin, output.file.url), 404);
      const target = {
        kind: "retained-output",
        outputId: output.file.retainedOutputId,
      };
      const before = await client.call("get_output_delivery", { target });
      assertSafeDelivery(before);
      assert.equal(before.retention.state, "retained");
      assert.equal(before.retention.source, "current");
      assert.equal(before.retention.content, "verified");
      assert.equal(before.retention.access, "allowed");
      assert.equal(before.observation.state, "not_observed");
      const link = await client.call("get_output_file", {
        id: output.file.retainedOutputId,
      });
      assert.notEqual(link.url, output.file.url);
      assert.equal(link.sha256, output.file.sha256);
      assert.equal(link.mimeType, output.file.mimeType);
      await assertExchangeHead(http.origin, {
        ...link,
        filename: output.file.filename,
      });
      const bytes = await completeExchangeResponse(
        http.origin,
        link.url,
        "GET",
        () => download(http.origin, link),
      );
      assert.ok(
        bytes.equals(output.bytes),
        "Retained bytes must not be reserialized",
      );
      const after = await client.call("get_output_delivery", { target });
      assertSafeDelivery(after);
      assert.deepEqual(after.observation.capabilities, {
        generated: 0,
        reissued: 1,
        latestCreatedAt: after.observation.capabilities.latestCreatedAt,
        latestExpiresAt: link.expiresAt,
      });
      assert.equal(after.observation.toolResponsesPrepared.text, 1);
      assert.equal(after.observation.toolResponsesPrepared.attachment, 0);
      assert.equal(after.observation.http.getCompleted, 1);
      assert.equal(after.observation.http.headCompleted, 1);
      assert.equal(after.observation.http.bytesQueued, output.bytes.length);
      assert.equal(after.observation.http.inFlight, 0);
      links.push({
        url: link.url,
        id: output.file.retainedOutputId,
        jobId: output.jobId,
      });
    }
    assert.equal((await client.call("list_jobs", {})).total, beforeJobs.total);
    assert.equal(
      observed.jobs.size,
      0,
      "Reissue must not start another native job",
    );
    assert.equal(observed.windows(), 0, "Reissue must not open a renderer");
    assert.equal(client.scopes.has("carrot.images"), false);
    await assertForeignDeliveryDenied(root, app, editing, outputs[0]);
    const discarded = links[0];
    await client.call("discard_retained", { id: discarded.id, confirm: true });
    assert.equal(await exchangeLinkStatus(http.origin, discarded.url), 404);
    await assert.rejects(() =>
      client.call("get_output_delivery", {
        target: { kind: "retained-output", outputId: discarded.id },
      }),
    );
    const historical = await client.call("get_output_delivery", {
      target: { kind: "job", jobId: discarded.jobId },
    });
    assertSafeDelivery(historical);
    assert.equal(historical.retention.state, "unavailable");
    for (const link of links.slice(1))
      assert.equal(await exchangeLinkStatus(http.origin, link.url), 200);
    client.revoke();
    for (const link of links.slice(1))
      assert.equal(await exchangeLinkStatus(http.origin, link.url), 404);
    await assert.rejects(() =>
      client.call("get_output_delivery", {
        target: { kind: "job", jobId: outputs[1].jobId },
      }),
    );
    assert.deepEqual(http.errors, []);
    assert.deepEqual(client.errors, []);
    await assertExchangeOriginals(root, source);
    console.log(
      "PASS native output delivery -> reconstructed encrypted text/context reissue -> real HTTP diagnostics and owner/discard/revocation denial; client receipt unconfirmed",
    );
  } finally {
    observed.stop();
    await Promise.all([activeHttp?.close(), activeClient?.close()]);
  }
}

/** @param {string} root @param {NativeApp} app @param {Editing} editing @param {Exported} output */
async function assertForeignDeliveryDenied(root, app, editing, output) {
  const foreign = await exchangeNativeClient(root, app, editing, {
    owner: "native-exchange-foreign",
  });
  try {
    await assert.rejects(() =>
      foreign.call("get_output_file", { id: output.file.retainedOutputId }),
    );
    await assert.rejects(() =>
      foreign.call("get_output_delivery", {
        target: {
          kind: "retained-output",
          outputId: output.file.retainedOutputId,
        },
      }),
    );
    await assert.rejects(() =>
      foreign.call("get_output_delivery", {
        target: { kind: "job", jobId: output.jobId },
      }),
    );
  } finally {
    await foreign.close();
  }
}
module.exports = { checkNativeDelivery };
